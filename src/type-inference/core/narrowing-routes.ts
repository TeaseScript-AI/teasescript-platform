import type { PlaceId } from "../graph.js";
import type { CorePass } from "./answers.js";
import { joinParts, keepText, type WorkLedger } from "./budget.js";
import { keptPrefixes, keyPath, keyPlace, type Definition, type Key } from "./definitions.js";
import type { FlowNode } from "./flow-graph.js";
import type { ItemTag } from "./items.js";
import type { Work } from "./solver.js";
import {
  copied,
  each,
  holds,
  mapped,
  passing,
  some,
  sorted,
  steps,
} from "./narrowing-iteration.js";
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

/**
 * A sparse layer of closed statements (N3, §13.3) over a parent layer: a key's kill layer over its parent key's (the
 * key's own kills, and the compound statements they close beside the shared layer and every layer below), or a key's
 * test layer for one offending kind over its kill layer (the blocking tests of the needed form, and what they close).
 * A prefix's kills stay in the prefix's layer, never copied into a descendant's. Per block, the indexes it closes
 * (sorted) and their number; per compound statement, how many of its live arms it closes.
 */
interface Layer {
  readonly parent: Layer | null;
  readonly statements: ReadonlySet<TreeStatement>;
  readonly closed: ReadonlyMap<number, readonly number[]>;
  readonly counts: ReadonlyMap<number, number>;
  readonly arms: ReadonlyMap<TreeStatement, number>;
  /** The shared layer's applicability: calls close only for a key with an owner outside its activation (X6). */
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
  for (const has of each(program.work, "exactQueries", program.hasOf.get(value) ?? []))
    if (has.type.kind === "atom") return has.type.name;
  return null;
}

/** The definitions N3 may certify (N3 (iii)): declarations, assignments, a parameter's default; never an argument. */
const CERTIFIED: ReadonlySet<string> = new Set(["initializer", "assignment", "parameter default"]);

export class NarrowingRoutes {
  /** Per key and applicability its kill layer, per (key, offending kind) its test layer. */
  readonly #layers = new Map<string, Layer>();
  /** Per (key, offending kind) its certified own definitions, and per key (`*`) its whole stores, by callable body. */
  readonly #candidates = new Map<string, ReadonlyMap<TreeBlock, Candidates>>();
  /** Per (key, node, offending kind): the witness found, or `null`. */
  readonly #witnesses = new Map<string, Definition | null>();
  /** The parameters a call binds an argument to, by key (an omitted default's certificate, N3), made once. */
  #arguments: ReadonlySet<Key> | null = null;
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
  public *witness(key: Key, tag: ItemTag, node: FlowNode): Work<Definition | null> {
    // a chain of copies: each query waits on its source's, the last first
    const waiting: { readonly memo: string; readonly found: Candidate }[] = [];
    let memo = joinParts(key, node.id, tag);
    let answer: Definition | null = null;
    for (const _ of steps(this.#work, "exactQueries", () => true)) {
      const known = this.#witnesses.get(memo);
      if (known !== undefined) {
        answer = known;
        break;
      }
      // (a query met again on its own chain proves nothing)
      keepText(this.#work, memo.length);
      this.#witnesses.set(memo, null);
      const found = yield* this.#examined(key, tag, node);
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
    for (const _ of steps(this.#work, "exactQueries", () => waiting.length > 0)) {
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
  *#examined(key: Key, tag: ItemTag, node: FlowNode): Work<Candidate | null> {
    const { program, handlers, contract } = this.pass;
    program.work.charge("exactQueries");
    if (!program.live(node) || program.blockReachable(node) || node.span === null) return null;
    // X7 as the flat veto it is: a handler store of the key with a registration before the read
    if (handlers.handlerTouches(key) && this.#registered(node)) return null;
    // positions and members are not facts: no element key and no reference member has a route
    const path = keyPath(key);
    // (`keyPath` walks the key's text)
    program.work.charge("eventSteps", path.length + 1);
    if (holds(program.work, "eventSteps", path, "element") || (yield* contract.refReceiver(key)))
      return null;
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
    for (const prefix of each(program.work, "eventSteps", keptPrefixes(program.work, key)))
      consider(this.#wholeStores(prefix));
    const found: Candidate | null = best;
    if (found === null) return null;
    return this.#open(key, tag, found, chain, node) ? found : null;
  }

  /** X7's registration-before-read predicate (`afterSomeCreation`), its scan of the read's loops charged. */
  #registered(node: FlowNode): boolean {
    this.pass.program.work.charge("eventSteps", node.loops.length + 1);
    return this.pass.handlers.afterSomeCreation(node);
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
    const { program, lists } = this.pass;
    const d = found.def;
    program.work.charge("exactQueries");
    // X3's exact definitions N3 certifies: a declaration, an assignment with a certain receiver, a single-site
    // parameter's default; never a weak store, an element or dict key, a loop variable, a return or an argument
    if (
      d.kind !== "whole" ||
      d.weak ||
      d.value === undefined ||
      !CERTIFIED.has(d.how) ||
      (d.how === "parameter default" && !lists.singleSite(d.fn)) ||
      !lists.certain(d)
    )
      return false;
    // a whole store of a prefix answers below it only through its literal's properties, to a seed
    // (`keyPath` walks the key's text)
    const full = keyPath(key);
    program.work.charge("exactQueries", full.length);
    const rest: string[] = [];
    let step = d.path.length;
    for (const _ of steps(program.work, "exactQueries", () => step < full.length)) {
      rest.push(full[step]!);
      step += 1;
    }
    let value: PlaceId = d.value;
    for (const step of each(program.work, "exactQueries", rest)) {
      const property = this.#property(value, propertyName(step));
      if (property === undefined) return false;
      value = property;
    }
    if (literalTag(program, value) === tag) {
      // a parameter's default is selected where the call omits the argument: its one call site binds none
      return d.how !== "parameter default" || !this.#argued().has(d.key);
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

  /** The keys of the parameters some call binds an argument to: one walk of the transfers, made once per pass. */
  #argued(): ReadonlySet<Key> {
    if (this.#arguments !== null) return this.#arguments;
    const { definitions, program } = this.pass;
    const argued = new Set<Key>();
    for (const d of each(program.work, "indexSteps", definitions.transferDefs))
      if (d.how === "argument") argued.add(d.key);
    this.#arguments = argued;
    return argued;
  }

  /** A read of a stable path without element steps: its key and node. */
  #scalarRead(value: PlaceId): { readonly key: Key; readonly node: FlowNode } | null {
    const program = this.pass.program;
    const site = program.places[value]?.site;
    const node = site === undefined || site === null ? null : program.exprAt(site);
    const expression = node?.expression;
    if (node === null || expression === undefined) return null;
    const path: StablePath | null = stablePath(program, node.file, expression);
    if (
      path === null ||
      some(program.work, "exactQueries", path.steps, (step) => step.kind !== "property")
    )
      return null;
    return { key: pathKey(path, program.work), node };
  }

  /** An object literal's property's stored value, by name. */
  #property(literal: PlaceId, name: string): PlaceId | undefined {
    const { program, definitions } = this.pass;
    let known = this.#properties.get(literal);
    if (known === undefined) {
      const made = new Map<string, PlaceId>();
      for (const has of each(program.work, "indexSteps", program.hasOf.get(literal) ?? [])) {
        if (has.type.kind !== "object" || has.type.properties === null) continue;
        for (const property of each(program.work, "indexSteps", has.type.properties)) {
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
    const upward: Place[] = [];
    let at: TreeStatement | null = statement;
    for (const _ of steps(this.#work, "eventSteps", () => at !== null)) {
      upward.push({ block: at!.block, index: at!.index });
      at = at!.block.owner;
    }
    // (from the body down)
    let index = upward.length;
    const chain: Place[] = [];
    for (const _ of steps(this.#work, "eventSteps", () => index > 0)) {
      index -= 1;
      chain.push(upward[index]!);
    }
    return chain;
  }

  /**
   * Whether a segment of a block, statements `low` to `high` exclusive, holds a closed statement: in the shared layer
   * (its applicability) or in a layer of the chain, two binary searches each.
   */
  #closed(
    block: TreeBlock,
    low: number,
    high: number,
    layer: Layer | null,
    calls: boolean,
  ): boolean {
    const work = this.#work;
    work.charge("eventSteps");
    if (countIn(work, calls ? block.calls : block.leaves, low, high) > 0) return true;
    let at = layer;
    for (const _ of steps(work, "eventSteps", () => at !== null)) {
      const own = at!.closed.get(block.id);
      if (own !== undefined && countIn(work, own, low, high) > 0) return true;
      at = at!.parent;
    }
    return false;
  }

  /**
   * The end of the block a definition's open writer side reaches (N3 (a)): from its statement up, each block's
   * statements after the one left open; out of a loop's body only where its header leaves it, its header open. N3's "no
   * back edge between" is the read never before the candidate in a body they share: a round's end that reaches the code
   * after the loop is the route out of it (the set's `3b/loop/nested/changed` errs on a `null` stored in an inner loop's
   * body and read after it); a loop only a `break` leaves stops the writer side.
   */
  #reach(chain: readonly Place[], layer: Layer | null, calls: boolean): number {
    let level = chain.length;
    for (const _ of steps(this.#work, "eventSteps", () => level > 0)) {
      level -= 1;
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
    const layer = this.#testLayer(key, tag);
    const writer = found.chain;
    let level = 0;
    for (const _ of steps(
      this.#work,
      "eventSteps",
      () =>
        level < writer.length &&
        level < chain.length &&
        writer[level]!.block === chain[level]!.block &&
        writer[level]!.index === chain[level]!.index,
    ))
      level += 1;
    // (b): the read's statement after the candidate's in their lowest shared block, never a sibling arm
    if (level >= writer.length || level >= chain.length) return false;
    const shared = writer[level]!.block;
    if (chain[level]!.block !== shared || chain[level]!.index <= writer[level]!.index) return false;
    // (a): the writer side, from the candidate's block up to the shared one, out of a loop through its header
    let up = writer.length;
    for (const _ of steps(this.#work, "eventSteps", () => up - 1 > level)) {
      up -= 1;
      const { block, index } = writer[up]!;
      if (this.#closed(block, index + 1, block.statements.length, layer, layer.calls)) return false;
      if (block.owner !== null && !this.#leaves(block.owner, layer.calls)) return false;
    }
    // (c): the statements between
    if (this.#closed(shared, writer[level]!.index + 1, chain[level]!.index, layer, layer.calls))
      return false;
    // (d): each entered block's statements before the read's
    let down = level + 1;
    for (const _ of steps(this.#work, "eventSteps", () => down < chain.length)) {
      const { block, index } = chain[down]!;
      if (this.#closed(block, 0, index, layer, layer.calls)) return false;
      down += 1;
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
   * A key's kill layer (§13.3's sparse per-key layer, its kills): the statements its own whole stores stand in, and the
   * compound statements they close beside the shared layer and its prefixes' kill layers; built once per key and
   * applicability, over the statements holding its own kills and their ancestors.
   */
  #killLayer(key: Key, calls: boolean): Layer {
    // (one unit per prefix the recursion climbs)
    this.#work.charge("indexSteps");
    const memo = joinParts(key, calls ? "calls" : "leaves");
    const known = this.#layers.get(memo);
    if (known !== undefined) return known;
    const { program, definitions, lists } = this.pass;
    const prefix = keptPrefixes(program.work, key)[0];
    const parent = prefix === undefined ? null : this.#killLayer(prefix, calls);
    const seeds: TreeStatement[] = [];
    for (const d of each(program.work, "indexSteps", definitions.byKey.get(key) ?? [])) {
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
      if (statement !== null) seeds.push(statement);
    }
    const layer = this.#build(parent, calls, seeds, null);
    keepText(program.work, memo.length);
    this.#layers.set(memo, layer);
    return layer;
  }

  /**
   * A key's test layer for an offending kind over its kill layer: the blocking tests of the needed form (every live
   * arm starts with a narrowing of the key's location that removes the kind, or is closed) and what they close.
   */
  #testLayer(key: Key, tag: ItemTag): Layer {
    const memo = joinParts(key, tag);
    const known = this.#layers.get(memo);
    if (known !== undefined) return known;
    const calls = this.pass.definitions.ownedAway(key);
    const parent = this.#killLayer(key, calls);
    const location = this.#location(key);
    const tests = new Set<TreeStatement>();
    if (location !== null)
      for (const g of each(this.#work, "indexSteps", this.index.definitionsOf(location))) {
        const owner = this.tree.armAt(g.node)?.owner;
        if (owner !== undefined && owner !== null) tests.add(owner);
      }
    const layer = this.#build(
      parent,
      calls,
      copied(this.#work, "indexSteps", tests),
      location === null
        ? null
        : (arm) =>
            arm.entry !== null &&
            some(this.#work, "indexSteps", this.index.atEntry(arm.entry, location), (g) =>
              removes(g.form, tag, this.#work),
            ),
    );
    keepText(this.#work, memo.length);
    this.#layers.set(memo, layer);
    return layer;
  }

  /**
   * A layer over `parent`: the `seeds` (kills) closed, or with `starts`, the seeds' arms that start with a narrowing of
   * the needed form counted closed; then every compound statement whose live arms are all closed, by the shared layer,
   * a layer below or this one, found from the arms that close, each arm counted once in one layer.
   */
  #build(
    parent: Layer | null,
    calls: boolean,
    seeds: readonly TreeStatement[],
    starts: ((arm: TreeBlock) => boolean) | null,
  ): Layer {
    const work = this.#work;
    const variant = calls ? "calls" : "leaves";
    const statements = new Set<TreeStatement>();
    const counts = new Map<number, number>();
    const arms = new Map<TreeStatement, number>();
    const counted = new Set<TreeBlock>();
    // (the layers below, from the nearest)
    const below = (): Generator<Layer> => {
      let at = parent;
      return (function* () {
        for (const _ of steps(work, "eventSteps", () => at !== null)) {
          yield at!;
          at = at!.parent;
        }
      })();
    };
    const closedBelow = (statement: TreeStatement): boolean =>
      statement[variant] ||
      some(work, "eventSteps", below(), (layer) => layer.statements.has(statement));
    const armBelow = (arm: TreeBlock): boolean =>
      arm[variant].length > 0 ||
      some(work, "eventSteps", below(), (layer) => (layer.counts.get(arm.id) ?? 0) > 0);
    const pending: TreeStatement[] = [];
    // an arm closed here for the first time counts for its statement, which may then close
    const close = (arm: TreeBlock): void => {
      if (counted.has(arm) || !arm.live || arm.owner === null || armBelow(arm)) return;
      counted.add(arm);
      arms.set(arm.owner, (arms.get(arm.owner) ?? 0) + 1);
      pending.push(arm.owner);
    };
    const mark = (statement: TreeStatement): void => {
      work.charge("indexSteps");
      if (statements.has(statement) || closedBelow(statement)) return;
      statements.add(statement);
      counts.set(statement.block.id, (counts.get(statement.block.id) ?? 0) + 1);
      close(statement.block);
    };
    const check = (statement: TreeStatement): void => {
      work.charge("indexSteps");
      if (statement.skip || statement.arms.length === 0 || statements.has(statement)) return;
      let closedArms = statement.sharedArms[variant] + (arms.get(statement) ?? 0);
      for (const layer of each(work, "eventSteps", below()))
        closedArms += layer.arms.get(statement) ?? 0;
      if (closedArms >= statement.liveArms) mark(statement);
    };
    for (const seed of each(work, "indexSteps", seeds)) {
      if (starts === null) mark(seed);
      else for (const arm of each(work, "indexSteps", seed.arms)) if (starts(arm)) close(arm);
      for (const _ of steps(work, "indexSteps", () => pending.length > 0)) check(pending.pop()!);
    }
    const closed = new Map<number, number[]>();
    for (const statement of each(work, "indexSteps", statements)) {
      const list = closed.get(statement.block.id);
      if (list === undefined) closed.set(statement.block.id, [statement.index]);
      else list.push(statement.index);
    }
    for (const list of each(work, "indexSteps", closed.values()))
      sorted(work, "indexSteps", list, (a, b) => a - b);
    return { parent, statements, closed, counts, arms, calls };
  }

  /** The refined location of a key without element steps: its properties' texts. */
  #location(key: Key): string | null {
    const work = this.#work;
    const path = keyPath(key);
    // (`keyPath` walks the key's text)
    work.charge("indexSteps", path.length + 1);
    if (holds(work, "indexSteps", path, "element")) return null;
    return locationOf(
      {
        root: keyPlace(key),
        steps: mapped(work, "indexSteps", path, (step) => ({
          kind: "property",
          name: propertyName(step),
        })),
      },
      work,
    );
  }

  /** A key's own exact definitions that certify `tag` where they stand (a seed or a certified read), by callable body. */
  #ownCandidates(key: Key, tag: ItemTag): ReadonlyMap<TreeBlock, Candidates> {
    const memo = joinParts(key, tag);
    const known = this.#candidates.get(memo);
    if (known !== undefined) return known;
    const layer = this.#testLayer(key, tag);
    const made = this.#candidateLists(
      passing(this.#work, "indexSteps", this.pass.definitions.byKey.get(key) ?? [], (d) =>
        this.#carries(d, tag),
      ),
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
      passing(
        this.#work,
        "indexSteps",
        this.pass.definitions.byKey.get(prefix) ?? [],
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
    for (const d of each(work, "indexSteps", definitions)) {
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
    for (const [body, list] of each(work, "indexSteps", byBody)) {
      sorted(
        work,
        "indexSteps",
        list,
        (a, b) => a.start - b.start || a.def.site.start - b.def.site.start,
      );
      let size = 1;
      for (const _ of steps(work, "indexSteps", () => size < list.length)) size *= 2;
      // a tree of maxima over the reaches, its leaves from `size` on
      const reaches: number[] = [];
      for (const _ of steps(work, "indexSteps", () => reaches.length < 2 * size)) {
        const leaf = reaches.length - size;
        reaches.push(leaf >= 0 && leaf < list.length ? list[leaf]!.reach : -Infinity);
      }
      let index = size;
      for (const _ of steps(work, "indexSteps", () => index > 1)) {
        index -= 1;
        reaches[index] = Math.max(reaches[2 * index]!, reaches[2 * index + 1]!);
      }
      made.set(body, {
        list,
        starts: mapped(work, "indexSteps", list, (candidate) => candidate.start),
        reaches,
        size,
      });
    }
    return made;
  }

  /** The last candidate starting before `at` whose writer side reaches `at`: a binary search and a descent. */
  #last(candidates: Candidates, at: number): Candidate | null {
    const work = this.#work;
    const before = lowerBound(work, candidates.starts, at);
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
