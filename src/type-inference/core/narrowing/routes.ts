import type { Expression } from "../../../ast.js";
import type { PlaceId, SourceSite } from "../../graph.js";
import type { CorePass } from "../answers.js";
import { joinParts, keepText, type WorkLedger } from "../budget.js";
import {
  keptParent,
  keptPrefixes,
  keyPath,
  keyPlace,
  type Definition,
  type Key,
} from "../definitions.js";
import type { FlowNode } from "../flow-graph.js";
import { REASON, type Item, type ItemTag } from "../items.js";
import type { Work } from "../solver.js";
import { copied, each, holds, mapped, passing, some, sorted, steps } from "../charged-iteration.js";
import { locationOf, pathKey, peel, removes, stablePath, type StablePath } from "./narrowings.js";
import { countIn, lowerBound, type TreeBlock, type TreeStatement } from "./statement-tree.js";
import { selectsElement } from "../method-categories.js";
import { RouteTests, type Place } from "./route-tests.js";
import { propertyName } from "../program.js";

/*
 * N3's route query of stage 3b (checkpoint 9): a consumer of key k at node n that needs a
 * kind k's contract does not guarantee (`null`, or a member of a written union) has a route without a check when an
 * exact definition D′ of k certifies the offending item and reaches n through an open corridor. Per key and offending
 * kind, built once on the key's first question:
 * - the **sparse per-key layer**: the statements that kill k (a whole store of k or a prefix), the blocking tests of the
 *   needed form (every live arm starts with a narrowing that removes the kind, or is closed), and the branches and loops
 *   every live alternative of which those close beside the shared layer (`statement-tree.ts`), computed over the
 *   statements holding a definition or a test of k and their ancestors: events and tests times the nesting depth;
 * - the **candidates kept at the key they store**: k's own definitions that certify the kind, and each prefix's whole
 *   stores, projected only for the one candidate examined; each with the reach of its writer side (the outermost block
 *   its open writer segments reach), so a consumer finds the nearest candidate whose writer side reaches it by one
 *   binary search over a tree of reaches, never a backward scan.
 * A consumer's query examines that one candidate: its certification (AD-1, #1073: what its stored value holds,
 * or a scalar copy whose source read has a witness by this same query, memoised per node and key; `#certificate`), then
 * the corridor's remaining segments (the middle and the consumer side), each one binary search per layer, and the
 * consumer's own statement's compulsory calls (the nearest call-in dominating n). An unsuitable candidate yields the
 * warning. The consumers ask it through `required`, the route rule's one decision (`consumers/warnings.ts`).
 */

/** A candidate D′ of a key: its definition, where it stands, and the end of the block its writer side reaches. */
interface Candidate {
  readonly def: Definition;
  readonly chain: readonly Place[];
  readonly start: number;
  readonly reach: number;
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
  program.work.charge("exactQueries");
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

/**
 * Whether items hold `tag` as a value the use may receive (AD-1): made by a store or a call's result, or allowed by a
 * written type (V30 §13: `n + 1` with `n: integer?` is the error); not a stopped read's (`budget`), not one under a
 * test's guard mark (§3.2), not a kind a test proved of external data, and not one another callable or a handler may
 * store (X6, X7: a run the compiler does not prove, V30 §13, "only where the compiler can prove the run").
 */
function produces(work: WorkLedger, items: readonly Item[], tag: ItemTag): boolean {
  work.charge("exactQueries");
  return some(
    work,
    "exactQueries",
    items,
    (item) =>
      item.tag === tag &&
      !((item.context === "call" && item.called !== true) || item.context === "handler") &&
      (item.reasons & REASON.budget) === 0 &&
      item.guarded !== true &&
      item.tested !== true &&
      item.fromExternal !== true,
  );
}

/**
 * The expressions that are their own value's producer at a use (AD-1): a call, a `load`, an `otherwise`, a selection
 * (`.first`, `.last`, `.random`).
 */
function producerAt(expression: Expression, work: WorkLedger): boolean {
  work.charge("exactQueries");
  const at = peel(expression, work);
  return (
    at.kind === "callExpression" ||
    at.kind === "loadExpression" ||
    (at.kind === "binaryExpression" && at.operator === "otherwise") ||
    (at.kind === "propertyAccessExpression" && selectsElement(at.property.name))
  );
}

/**
 * The definitions N3 may certify (N3 (iii)): declarations, assignments, a property's store, a parameter's default; never
 * an argument, a return or a loop variable.
 */
const CERTIFIED: ReadonlySet<string> = new Set([
  "initializer",
  "assignment",
  "property",
  "parameter default",
]);

export class NarrowingRoutes extends RouteTests {
  /** Per key and applicability its kill layer, per (key, offending kind) its test layer. */
  readonly #layers = new Map<string, Layer>();
  /** Per (key, offending kind) its certified own definitions, and per key (`*`) its whole stores, by callable body. */
  readonly #candidates = new Map<string, ReadonlyMap<TreeBlock, Candidates>>();
  /** Per (key, node, offending kind): the witness found, or `null`. */
  readonly #witnesses = new Map<string, Definition | null>();
  /** THROWAWAY (#1938 R33 counters): each witness step's writer chain, query node and its source's memo. */
  readonly #links = new Map<string, { readonly chain: readonly Place[]; readonly node: FlowNode; readonly next: string | null; readonly key: Key; readonly def: Definition }>();
  /** THROWAWAY: the current `required` query's first witness memo. */
  #first: { readonly memo: string; readonly node: FlowNode } | null = null;
  /** Per object literal: its properties' places by name, made on its first projection. */
  readonly #properties = new Map<PlaceId, ReadonlyMap<string, PlaceId>>();
  /** The program's ledger. */
  readonly #work: WorkLedger = this.pass.program.work;

  /**
   * AD-1 (#1073, V30 §13) at a consumer's read of `value` whose items hold the offending `tag`: the writer of a
   * route that brings it there without a check, or `null` where the compiler proves none, and the consumer warns with
   * its check. A stable read without element steps asks N3's witness, its D′'s stored value the writer; a call, a
   * `load`, an `otherwise` or a selection read where it is used is its own producer, the writer where its value produces
   * the kind, unless a condition around the use tests it. Any other read keeps its warning: an element step or a
   * reference member, which the route query does not follow (#1073 PR 4, decision (A)).
   */
  public *required(
    value: PlaceId,
    tag: ItemTag,
    others: readonly ItemTag[] = [],
  ): Work<SourceSite | null> {
    const result = yield* this.#requiredInner(value, tag, others);
    if (result !== null) this.#n3Count(value, result);
    return result;
  }

  *#requiredInner(
    value: PlaceId,
    tag: ItemTag,
    others: readonly ItemTag[] = [],
  ): Work<SourceSite | null> {
    this.#first = null;
    this.#work.charge("exactQueries");
    const program = this.pass.program;
    const site = program.places[value]?.site ?? null;
    if (site === null) return null;
    const node = program.exprAt(site);
    // (the default: no error in a program that holds an infeasible arm, the use keeps the warning, #1938)
    if (yield* this.holdsInfeasible()) return null;
    // (a value whose node reads no expression, a call's, a `get`'s or a `load`'s result, is its own producer; any other,
    // a compound assignment's operand among them, keeps its warning)
    if (node === null || node.expression === undefined) {
      const c = program.opOf.get(value)?.kind;
      return (c === "call" || c === "get" || c === "load" || c === "fallback") &&
        (node === null || program.live(node)) &&
        (yield* this.#valueProduces(value, node, [], tag))
        ? site
        : null;
    }
    const expression = node.expression;
    if (!program.live(node)) return null;
    const path = stablePath(program, node.file, expression);
    const last = path === null ? undefined : path.steps[path.steps.length - 1];
    // (a selection, `.first`, `.last`, `.random`, is its own producer where it is read, as a call is)
    if (path === null || (last?.kind === "property" && selectsElement(last.name)))
      return (path !== null || producerAt(expression, program.work)) &&
        !this.checked(node, this.text(site), tag, -1) &&
        (yield* this.#valueProduces(value, node, [], tag))
        ? site
        : null;
    if (some(program.work, "exactQueries", path.steps, (step) => step.kind !== "property"))
      return null;
    const key0 = pathKey(path, program.work);
    this.#first = { memo: joinParts(key0, node.id, tag, this.#othersText(others)), node };
    const d = yield* this.witness(key0, tag, node, others);
    const writer = d?.value === undefined ? null : (program.places[d.value]?.site ?? null);
    // (a test of the needed form after the writer on every route to the use, `while n == null { … }`: the check on that
    // route the compiler cannot keep, the warning; Codex r1 F1 on #1937)
    if (writer === null || this.checked(node, this.text(site), tag, writer.start)) return null;
    return writer;
  }

  /**
   * N3 (iii): an exact definition D′ of `key` that certifies `tag` and reaches `node` without a check, or `null` when the
   * compiler proves no such route (the consumer then warns with its check). The witness of a copy or an `otherwise`
   * asks this same query of its source, one memoised query per node and key, resolved without native recursion.
   * `others`: where `tag` is a member of the written union `key` declares, the union's other kinds the use does not
   * take, which certify the route as `tag` does (#1073: the written domain proves itself).
   */
  public *witness(
    key: Key,
    tag: ItemTag,
    node: FlowNode,
    others: readonly ItemTag[] = [],
  ): Work<Definition | null> {
    this.#work.charge("eventSteps");
    // a chain of copies: each query waits on its source's, the last first
    const waiting: { readonly memo: string; readonly found: Candidate }[] = [];
    let memo = joinParts(key, node.id, tag, this.#othersText(others));
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
      const found = yield* this.#examined(key, tag, node, others);
      const source = found === null ? false : yield* this.#certificate(found, key, tag, others);
      if (found === null || source === false) {
        answer = null;
        break;
      }
      this.#links.set(memo, {
        chain: found.chain,
        node,
        key,
        def: found.def,
        next: source === true ? null : joinParts(source.key, source.node.id, source.tag, ""),
      });
      if (source === true) {
        this.#witnesses.set(memo, found.def);
        answer = found.def;
        break;
      }
      waiting.push({ memo, found });
      ({ key, tag, node } = source);
      others = [];
      memo = joinParts(key, node.id, tag, "");
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
  *#examined(
    key: Key,
    tag: ItemTag,
    node: FlowNode,
    others: readonly ItemTag[],
  ): Work<Candidate | null> {
    this.#work.charge("exactQueries");
    const { program, handlers, contract } = this.pass;
    if (!program.live(node) || program.blockReachable(node) || node.span === null) return null;
    // X7 as the flat veto it is: a handler store of the key with a registration before the read
    if (handlers.handlerTouches(key) && this.#registered(node)) return null;
    // positions and members are not facts: no element key and no reference member has a route
    const path = keyPath(key);
    // (`keyPath` walks the key's text)
    program.work.charge("eventSteps", path.length + 1);
    if (holds(program.work, "eventSteps", path, "element") || (yield* contract.refReceiver(key)))
      return null;
    const chain = this.chainOf(node);
    if (chain === null) return null;
    const body = chain[0]!.block;
    const at = node.span.start.offset;
    let best: Candidate | null = null;
    const consider = (lists: ReadonlyMap<TreeBlock, Candidates>): void => {
      program.work.charge("eventSteps");
      const candidates = lists.get(body);
      const found = candidates === undefined ? null : this.#last(candidates, at);
      if (found !== null && (best === null || found.start > best.start)) best = found;
    };
    consider(yield* this.#ownCandidates(key, tag, others));
    for (const prefix of each(program.work, "eventSteps", keptPrefixes(program.work, key)))
      consider(this.#wholeStores(prefix));
    // EVIDENCE: `consider` assigns `best` in its closure, which TypeScript's flow analysis does not track.
    const found = best as Candidate | null;
    if (found === null) return null;
    // (a store whose own statement holds the read takes effect after it, `n += 1`: it brings the read nothing)
    const last = found.chain[found.chain.length - 1]!;
    const statement = last.index < 0 ? undefined : last.block.statements[last.index];
    if (statement !== undefined && statement.start <= at && at < statement.end) return null;
    const stored = found.def.value === undefined ? null : program.places[found.def.value]?.site;
    if (stored !== undefined && stored !== null && stored.start <= at && at < stored.end)
      return null;
    return this.#open(key, tag, found, chain, node) ? found : null;
  }

  /** X7's registration-before-read predicate (`afterSomeCreation`), its scan of the read's loops charged. */
  #registered(node: FlowNode): boolean {
    this.#work.charge("eventSteps");
    this.#work.charge("eventSteps", node.loops.length);
    return this.pass.handlers.afterSomeCreation(node);
  }

  /**
   * Whether a candidate certifies the offending item for `key` (N3 (iii), N3a, re-derived by AD-1, #1073): `true`
   * where its stored value produces the kind on some run, `false` where it does not, or the read whose own witness
   * certifies it (a scalar copy's source, a whole copy's source below the copied path, an `otherwise`'s left operand).
   * Every producer certifies by what its value holds (a literal, a default of any kind, a lookup, a parse, a
   * conversion, a fallback): no producer is refused as such. A parameter's default is in its read's items only where
   * some call omits the argument (V30: an error only for a run that can happen).
   */
  *#certificate(
    found: Candidate,
    key: Key,
    tag: ItemTag,
    others: readonly ItemTag[],
  ): Work<boolean | { readonly key: Key; readonly tag: ItemTag; readonly node: FlowNode }> {
    this.#work.charge("exactQueries");
    const { program, lists } = this.pass;
    const d = found.def;
    // X3's exact definitions N3 certifies: a declaration, an assignment with a certain receiver, a parameter's default;
    // never a weak store, an element or dict key, a loop variable, a return or an argument
    if (
      d.kind !== "whole" ||
      d.weak ||
      d.value === undefined ||
      !CERTIFIED.has(d.how) ||
      !lists.certain(d)
    )
      return false;
    // a whole store of a prefix answers below it through its literal's properties, else through what its value holds
    // there (`keyPath` walks the key's text)
    const full = keyPath(key);
    program.work.charge("exactQueries", full.length);
    const rest: string[] = [];
    let step = d.path.length;
    for (const _ of steps(program.work, "exactQueries", () => step < full.length)) {
      rest.push(full[step]!);
      step += 1;
    }
    let value: PlaceId = d.value;
    let below = 0;
    for (const _ of steps(program.work, "exactQueries", () => below < rest.length)) {
      const property = this.#property(value, propertyName(rest[below]!));
      if (property === undefined) break;
      value = property;
      below += 1;
    }
    const left: string[] = [];
    for (const _ of steps(program.work, "exactQueries", () => below < rest.length)) {
      left.push(rest[below]!);
      below += 1;
    }
    program.work.charge("exactQueries", left.length);
    if (left.length === 0) {
      const literal = literalTag(program, value);
      if (literal !== null)
        return (
          literal === tag || some(program.work, "exactQueries", others, (kind) => kind === literal)
        );
      const c = program.opOf.get(value);
      // `a otherwise <literal>`: live, and selected where `a` is the literal `null` or its own `null` is certified at
      // that node
      if (c?.kind === "fallback" && literalTag(program, c.right) === tag) {
        const right = program.places[c.right]?.site;
        const fallback = right === undefined || right === null ? null : program.exprAt(right);
        if (fallback === null || !program.live(fallback)) return false;
        if (literalTag(program, c.left) === "null") return true;
        const read = this.#scalarRead(c.left);
        if (read !== null) return { key: read.key, tag: "null", node: read.node };
      }
    }
    // a scalar copy whose source read has a certified witness
    const read = left.length === 0 ? this.#scalarRead(value) : null;
    if (read !== null) return { key: read.key, tag, node: read.node };
    // any other producer, a whole copy below the copied path among them, by what its value holds there on some run,
    // neither stopped nor read under a failed test: one answer per read, never a route per field of each copy (W34)
    if (yield* this.#valueProduces(value, d.node, left, tag)) return true;
    for (const kind of each(program.work, "exactQueries", others))
      if (yield* this.#valueProduces(value, d.node, left, kind)) return true;
    return false;
  }

  /** A memo key's part for a written union's other kinds, each charged. */
  #othersText(others: readonly ItemTag[]): string {
    this.#work.charge("exactQueries");
    let text = "";
    for (const kind of each(this.#work, "exactQueries", others)) text = joinParts(text, kind);
    return text;
  }

  /**
   * Whether a value produces `tag` on some run where it stands (`node`), below `path`: a literal of that kind; an
   * `otherwise` its left side's kinds, and its fallback's only where that left side can be null (a fallback that is
   * never selected produces nothing, #1737), its chain of left sides walked iteratively; any other value as its items
   * say (`produces`).
   */
  *#valueProduces(
    value: PlaceId,
    node: FlowNode | null,
    path: readonly string[],
    tag: ItemTag,
  ): Work<boolean> {
    this.#work.charge("exactQueries");
    const program = this.pass.program;
    if (path.length > 0)
      return produces(program.work, yield* this.pass.values.valueItems(value, node, path), tag);
    // (the fallbacks from the outermost in, down to the first left side that is none)
    const rights: PlaceId[] = [];
    let left = value;
    for (const _ of steps(
      program.work,
      "exactQueries",
      () => program.opOf.get(left)?.kind === "fallback",
    )) {
      const c = program.opOf.get(left)!;
      if (c.kind !== "fallback") break;
      rights.push(c.right);
      left = c.left;
    }
    const holds = function* (at: PlaceId, kind: ItemTag, routes: NarrowingRoutes): Work<boolean> {
      program.work.charge("exactQueries");
      const literal = literalTag(program, at);
      if (literal !== null) return literal === kind;
      return produces(program.work, yield* routes.pass.values.valueItems(at, node, []), kind);
    };
    // from the innermost out: whether the value so far can be null, and whether it produced the kind
    let nullable = yield* holds(left, "null", this);
    let produced = tag !== "null" && (yield* holds(left, tag, this));
    let index = rights.length;
    for (const _ of steps(program.work, "exactQueries", () => index > 0)) {
      index -= 1;
      const right = rights[index]!;
      if (!nullable) break;
      if (tag !== "null" && !produced) produced = yield* holds(right, tag, this);
      nullable = yield* holds(right, "null", this);
    }
    return tag === "null" ? nullable : produced;
  }

  /** A read of a stable path without element steps: its key and node. */
  #scalarRead(value: PlaceId): { readonly key: Key; readonly node: FlowNode } | null {
    this.#work.charge("exactQueries");
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
    this.#work.charge("exactQueries");
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
    this.#work.charge("eventSteps");
    const work = this.#work;
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
    this.#work.charge("eventSteps");
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
    this.#work.charge("eventSteps");
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
    this.#work.charge("eventSteps");
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
    // (only the parent's text, made and charged once per key by the memo: the whole prefix list at every ancestor kept
    // a chain's text cubic, #1748)
    const prefix = keptParent(program.work, key);
    const parent = prefix === null ? null : this.#killLayer(prefix, calls);
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
    this.#work.charge("indexSteps");
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
        : (arm) => {
            this.#work.charge("indexSteps");
            return (
              arm.entry !== null &&
              some(this.#work, "indexSteps", this.index.atEntry(arm.entry, location), (g) =>
                removes(g.form, tag, this.#work),
              )
            );
          },
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
    this.#work.charge("indexSteps");
    const work = this.#work;
    const variant = calls ? "calls" : "leaves";
    const statements = new Set<TreeStatement>();
    const counts = new Map<number, number>();
    const arms = new Map<TreeStatement, number>();
    const counted = new Set<TreeBlock>();
    // (the layers below, from the nearest)
    const below = (): Generator<Layer> => {
      work.charge("eventSteps");
      let at = parent;
      return (function* () {
        work.charge("eventSteps");
        for (const _ of steps(work, "eventSteps", () => at !== null)) {
          yield at!;
          at = at!.parent;
        }
      })();
    };
    const closedBelow = (statement: TreeStatement): boolean => {
      work.charge("eventSteps");
      return (
        statement[variant] ||
        some(work, "eventSteps", below(), (layer) => layer.statements.has(statement))
      );
    };
    const armBelow = (arm: TreeBlock): boolean => {
      work.charge("eventSteps");
      return (
        arm[variant].length > 0 ||
        some(work, "eventSteps", below(), (layer) => (layer.counts.get(arm.id) ?? 0) > 0)
      );
    };
    const pending: TreeStatement[] = [];
    // an arm closed here for the first time counts for its statement, which may then close
    const close = (arm: TreeBlock): void => {
      work.charge("indexSteps");
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
    this.#work.charge("indexSteps");
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
  *#ownCandidates(
    key: Key,
    tag: ItemTag,
    others: readonly ItemTag[],
  ): Work<ReadonlyMap<TreeBlock, Candidates>> {
    this.#work.charge("indexSteps");
    const memo = joinParts(key, tag, this.#othersText(others));
    const known = this.#candidates.get(memo);
    if (known !== undefined) return known;
    const layer = this.#testLayer(key, tag);
    const carrying: Definition[] = [];
    for (const d of each(this.#work, "indexSteps", this.pass.definitions.byKey.get(key) ?? []))
      if (yield* this.#carries(d, tag, others)) carrying.push(d);
    const made = this.#candidateLists(carrying, layer, layer.calls);
    keepText(this.#work, memo.length);
    this.#candidates.set(memo, made);
    return made;
  }

  /**
   * Whether a definition's own value could certify `tag`: a literal of that kind, else what the value holds where it is
   * stored (a copy's source as read there, any other producer's value), neither stopped nor read under a failed test
   * (AD-1: no producer is refused as such).
   */
  *#carries(d: Definition, tag: ItemTag, others: readonly ItemTag[]): Work<boolean> {
    this.#work.charge("indexSteps");
    const program = this.pass.program;
    if (d.kind !== "whole" || d.weak || d.value === undefined) return false;
    const literal = literalTag(program, d.value);
    if (literal !== null)
      return (
        literal === tag || some(program.work, "indexSteps", others, (kind) => kind === literal)
      );
    if (yield* this.#valueProduces(d.value, d.node, [], tag)) return true;
    for (const kind of each(program.work, "indexSteps", others))
      if (yield* this.#valueProduces(d.value, d.node, [], kind)) return true;
    return false;
  }

  /** A prefix's whole stores, by callable body, their reach by the shared layer alone (checked whole when examined). */
  #wholeStores(prefix: Key): ReadonlyMap<TreeBlock, Candidates> {
    this.#work.charge("indexSteps");
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
    this.#work.charge("indexSteps");
    const { program, lists } = this.pass;
    const work = program.work;
    const byBody = new Map<TreeBlock, Candidate[]>();
    for (const d of each(work, "indexSteps", definitions)) {
      if (!lists.live(d) || !program.live(d.node) || program.inBlockCode(d.node)) continue;
      const chain = this.chainOf(d.node);
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
    this.#work.charge("eventSteps");
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

  /** THROWAWAY (#1938 R33): one JSON line per N3 error, its witness's conditional arms and their complements. */
  #n3Count(value: PlaceId, writer: SourceSite): void {
    const g = globalThis as any;
    const out = g.process?.env?.I1938_N3;
    if (out === undefined) return;
    const program = this.pass.program;
    const site = program.places[value]?.site ?? null;
    const links: { readonly chain: readonly Place[]; readonly node: FlowNode; readonly key: Key; readonly def: Definition }[] = [];
    let unknown = false;
    if (this.#first !== null) {
      let memo: string | null = this.#first.memo;
      let guard = 0;
      while (memo !== null && guard < 10000) {
        guard += 1;
        const link = this.#links.get(memo);
        if (link === undefined) {
          unknown = true;
          break;
        }
        links.push(link);
        memo = link.next;
      }
    }
    const conditional = (b: TreeBlock): boolean => {
      const k = (b.owner?.statement as any)?.kind;
      return k === "ifStatement" || k === "switchStatement";
    };
    const blocksOf = (chain: readonly Place[]): Set<TreeBlock> => new Set(chain.map((p) => p.block));
    const entered = new Set<TreeBlock>();
    let sharedLoop = false;
    for (const link of links) {
      const w = blocksOf(link.chain);
      const u = blocksOf(this.chainOf(link.node) ?? []);
      for (const b of w) if (!u.has(b) && conditional(b)) entered.add(b);
      for (const b of u) if (!w.has(b) && conditional(b)) entered.add(b);
      for (const b of w) if (u.has(b) && b.owner !== null && b.owner.loop !== null) sharedLoop = true;
    }
    // the ways past an `if` between a link's writer and its query node whose arm holds another definition of the key
    const passed = new Map<TreeStatement, Set<number>>();
    for (const link of links) {
      const last = link.chain[link.chain.length - 1];
      const ws = last === undefined || last.index < 0 ? undefined : last.block.statements[last.index];
      const from = ws === undefined ? -1 : ws.end;
      const to = link.node.span === null ? -1 : link.node.span.start.offset;
      const root = link.chain[0]?.block;
      for (const d of this.pass.definitions.byKey.get(link.key) ?? []) {
        if (d === link.def || d.node.span === null) continue;
        const dc = this.chainOf(d.node) ?? [];
        if (dc[0]?.block !== root) continue;
        for (let i = dc.length - 1; i >= 0; i -= 1) {
          const b = dc[i]!.block;
          if (!conditional(b)) continue;
          const s = b.owner!;
          if (s.start >= from && s.end <= to) {
            const set = passed.get(s) ?? new Set<number>();
            set.add(s.arms.indexOf(b));
            passed.set(s, set);
          }
          break;
        }
      }
    }
    const textOf = (file: number, e: any): string =>
      program.textAt({ file, start: e.span.start.offset, end: e.span.end.offset } as any).replace(/\s+/g, " ");
    const fact = (file: number, e: any, pol: boolean): { text: string; pol: boolean; form: string } => {
      for (let i = 0; i < 100; i += 1) {
        if (e.kind === "parenthesizedExpression") e = e.expression;
        else if (e.kind === "unaryExpression" && e.operator === "not") {
          e = e.operand;
          pol = !pol;
        } else break;
      }
      if (e.kind === "typeTestExpression")
        return { text: `${textOf(file, e.value)} is ${textOf(file, e.type)}`, pol: e.negated ? !pol : pol, form: "is" };
      if (e.kind === "binaryExpression" && (e.operator === "==" || e.operator === "!=")) {
        const l = textOf(file, e.left);
        const r = textOf(file, e.right);
        const nul = l === "null" || r === "null";
        return { text: `${l} == ${r}`, pol: e.operator === "!=" ? !pol : pol, form: nul ? "null" : "eq" };
      }
      return { text: textOf(file, e), pol, form: "bool" };
    };
    const facts: { text: string; pol: boolean; form: string; owner: TreeStatement; passed: boolean }[] = [];
    let passes = 0;
    for (const [s, killed] of passed) {
      const st = s.statement as any;
      if (st.kind !== "ifStatement" || killed.size !== 1 || entered.has(s.arms[0]!) || entered.has(s.arms[1]!)) continue;
      passes += 1;
      facts.push({ ...fact(s.file, st.condition, killed.has(0) ? false : true), owner: s, passed: true });
    }
    let switches = 0;
    for (const b of entered) {
      const owner = b.owner!;
      const s = owner.statement as any;
      if (s.kind !== "ifStatement") {
        switches += 1;
        continue;
      }
      const arm = owner.arms.indexOf(b);
      facts.push({ ...fact(owner.file, s.condition, arm === 0), owner, passed: false });
    }
    const complements: { text: string; form: string; same: boolean; passed: number }[] = [];
    for (let i = 0; i < facts.length; i += 1)
      for (let j = i + 1; j < facts.length; j += 1)
        if (facts[i]!.text === facts[j]!.text && facts[i]!.pol !== facts[j]!.pol && facts[i]!.owner.file === facts[j]!.owner.file)
          complements.push({
            text: facts[i]!.text,
            form: facts[i]!.form,
            same: facts[i]!.owner === facts[j]!.owner,
            passed: (facts[i]!.passed ? 1 : 0) + (facts[j]!.passed ? 1 : 0),
          });
    const fs = g.process.getBuiltinModule("node:fs");
    fs.appendFileSync(
      out,
      JSON.stringify({
        source: g.I1938_SOURCE ?? null,
        use: site === null ? null : [site.file, site.start, site.end],
        text: site === null ? null : program.textAt(site),
        writer: [writer.file, writer.start, writer.end],
        own: this.#first === null,
        links: links.length,
        unknown,
        arms: entered.size,
        switches,
        passes,
        sharedLoop,
        complements,
      }) + "\n",
    );
  }

}
