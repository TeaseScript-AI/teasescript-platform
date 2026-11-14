import type { Expression } from "../../../ast.js";
import type { PlaceId } from "../../graph.js";
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
import { copied, each, holds, mapped, some, sorted, steps } from "../charged-iteration.js";
import { locationOf, pathKey, peel, removes, stablePath, type StablePath } from "./narrowings.js";
import { countIn, type TreeBlock, type TreeStatement } from "./statement-tree.js";
import { selectsElement } from "../method-categories.js";
import type { Place } from "./route-tests.js";
import type { Candidate, Candidates, Layer } from "./route-candidates.js";
import {
  RouteEntries,
  rootName,
  type Entry,
  type EntryPoint,
  type RouteWriter,
} from "./route-entries.js";
import { propertyName } from "../program.js";

/*
 * The route query (r4-444): a consumer of key k at node n that needs a kind k's contract does not guarantee (`null`, or
 * a member of a written union) has a route without a check when an exact definition D′ of k certifies the offending
 * item and reaches n through an open corridor. Per key and offending kind, built once on the key's first question:
 * - the **sparse per-key layer**: the statements that kill k (a whole store of k or a prefix), the blocking tests of
 *   the needed form (every live arm starts with a narrowing that removes the kind, or is closed), and the branches and
 *   loops every live alternative of which those close beside the shared layer (`statement-tree.ts`), computed over the
 *   statements holding a definition or a test of k and their ancestors: events and tests times the nesting depth;
 * - the **candidates kept at the key they store**: k's own definitions that certify the kind, and each prefix's whole
 *   stores, projected only for the one candidate examined; each with the reach of its writer side (the outermost block
 *   its open writer segments reach), so a consumer finds the nearest candidate whose writer side reaches it by one
 *   binary search over a tree of reaches, never a backward scan.
 * A consumer's query examines that one candidate: its certification (r4-444, #1073: what its stored value holds,
 * or a scalar copy whose source read has a witness by this same query, memoised per node and key; `#certificate`), then
 * the corridor's remaining segments (the middle and the consumer side), each one binary search per layer, and the
 * consumer's own statement's compulsory calls (the nearest call-in dominating n). An unsuitable candidate yields the
 * warning.
 */

/** A literal's kind as the route query reads it: `null`, a whole or fractional number, text, a truth value. */
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
 * Whether items hold `tag` as a value the use may receive (r4-444): made by a store or a call's result, or allowed by a
 * written type (V30 §13: `n + 1` with `n: integer?` is the error); not a stopped read's (`budget`), not one under a
 * test's guard mark, not one read where a test that removes it failed (`tested`), not a kind a test proved of external
 * data, and not one another callable or a handler may store (a write by a block or by a function in between, which
 * V30 §13 makes a warning).
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
 * The expressions that are their own value's producer at a use: a call, a `load`, an `otherwise`, a selection
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
 * The definitions the route query may certify: declarations, assignments, a property's store, a parameter's default;
 * never an argument, a return or a loop variable.
 */
const CERTIFIED: ReadonlySet<string> = new Set([
  "initializer",
  "assignment",
  "property",
  "parameter default",
]);

export class NarrowingRoutes extends RouteEntries {
  /** Per key and applicability its kill layer, per (key, offending kind) its test layer. */
  readonly #layers = new Map<string, Layer>();
  /** Per (key, node, offending kind): the witness found, or `null`. */
  readonly #witnesses = new Map<string, Definition | null>();
  /** Per object literal: its properties' places by name, made on its first projection. */
  readonly #properties = new Map<PlaceId, ReadonlyMap<string, PlaceId>>();
  /** The program's ledger. */
  readonly #work: WorkLedger = this.pass.program.work;
  /** The keys the program saves under, and whether it saves under a computed one (`#ownLoad`), made on first use. */
  #saves: { readonly keys: ReadonlySet<string>; readonly computed: boolean } | null = null;

  /**
   * The route rule (r4-444, #1073, V30 §13) at a consumer's read of `value` whose items hold the offending `tag`: the
   * writer of a route that brings it there without a check, or `null` where the compiler proves none, and the consumer
   * warns with its check. A stable read without element steps asks `witness`, its D′'s stored value the writer; a call,
   * a `load`, an `otherwise` or a selection read where it is used is its own producer, the writer where its value
   * produces the kind, unless a condition around the use tests it. Any other read keeps its warning: an element step or
   * a reference member, which the route query does not follow (#1073).
   *
   * In a program that holds an arm no run is proved to enter (`defaultHolds`), a route promotes only through arms
   * runs enter, between a writer and a use that stand in the session's first file's top level with nothing on their
   * chains a run might not pass (`#plain`), and only by a certificate its own value proves: a literal, a scalar copy
   * of one, an `otherwise` selected by its left side's own witness, a `load` whose literal default a run selects
   * (`#ownLoad`). Everything else there keeps the warning (#1938).
   *
   * Past that query, a `null` read of a stable path may come through a way into the use (r4-451, `RouteEntries`): a
   * loop's earlier round, a label, a file's start, a block's body. In a block's body the query above runs inside the
   * body alone, without the handler veto (`#registered`), by r4-451's segment. `flagged`: the use's item carries a
   * test's mark, so the query above is not asked outside a block's body; the ways in are, as they hold the test to
   * their own segments. In a program the default holds, only a loop's or a label's way in (r4-451,
   * `RouteEntries.standsAt`).
   */
  public *required(
    value: PlaceId,
    tag: ItemTag,
    others: readonly ItemTag[] = [],
    flagged = false,
  ): Work<RouteWriter | null> {
    this.#work.charge("exactQueries");
    const program = this.pass.program;
    const site = program.places[value]?.site ?? null;
    if (site === null) return null;
    const node = program.exprAt(site);
    if ((yield* this.defaultHolds()) && this.feasible === null)
      this.feasible = yield* this.feasibility();
    if (flagged && (node === null || !this.inBody(node))) {
      const path =
        node?.expression === undefined ? null : stablePath(program, node.file, node.expression);
      return node === null || path === null ? null : yield* this.#entered(node, path, tag);
    }
    if (node === null || node.expression === undefined) {
      const c = program.opOf.get(value)?.kind;
      return (c === "call" || c === "get" || c === "load" || c === "fallback") &&
        (node === null || program.live(node)) &&
        (this.feasible === null
          ? yield* this.#valueProduces(value, node, [], tag)
          : this.#inlineLoad(value, node, tag))
        ? { writer: site, block: null }
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
        (this.feasible === null
          ? yield* this.#valueProduces(value, node, [], tag)
          : this.#inlineLoad(value, node, tag))
        ? { writer: site, block: null }
        : null;
    if (some(program.work, "exactQueries", path.steps, (step) => step.kind !== "property"))
      return null;
    const key = pathKey(path, program.work);
    const d = yield* this.witness(key, tag, node, others);
    const writer = d?.value === undefined ? null : (program.places[d.value]?.site ?? null);
    // (a test of the needed form after the writer on every route to the use, `while n == null { … }`: the check on that
    // route the compiler cannot keep, the warning, #1937; in a block's body, r4-451's segment)
    if (writer !== null) {
      const body = this.inBody(node);
      const from = body ? this.chainOf(d!.node) : null;
      const point = body ? this.pointOf(node) : null;
      const name = body ? rootName(expression, program.work) : null;
      if (
        body
          ? from !== null &&
            point !== null &&
            name !== null &&
            this.writerOpen(key, name, from, point)
          : !this.checked(node, this.text(site), tag, writer.start)
      )
        return { writer, block: null };
    }
    return yield* this.#entered(node, path, tag);
  }

  /**
   * A way into the use of a stable path's `null` (r4-451, `RouteEntries.entered`): none for a kind but `null`, an
   * element step, and outside a block's body for code a block may reach and for a key a block stores once registered;
   * in a program the default holds, a loop's or a label's alone (r4-451).
   */
  *#entered(node: FlowNode, path: StablePath, tag: ItemTag): Work<RouteWriter | null> {
    this.#work.charge("exactQueries");
    const { program, handlers } = this.pass;
    if (
      tag !== "null" ||
      !program.live(node) ||
      some(program.work, "exactQueries", path.steps, (step) => step.kind !== "property")
    )
      return null;
    const key = pathKey(path, program.work);
    if (
      !this.inBody(node) &&
      (program.blockReachable(node) || (handlers.handlerTouches(key) && this.#registered(node)))
    )
      return null;
    return yield* this.entered(node, key);
  }

  /**
   * The seed at a jump's point (r4-451): the nearest certified `null` store before it in its body (the candidate a use
   * there would examine, a block's own in a block's body), its route to the point open, its segment holding nothing.
   */
  protected *seedAt(
    key: Key,
    name: string,
    point: EntryPoint,
    into: Entry,
  ): Work<Definition | null> {
    this.#work.charge("exactQueries");
    const found = yield* this.#examinedAt(key, "null", point.node, point.chain, point.at, [], into);
    return found !== null &&
      (yield* this.certifies(found, key)) &&
      this.writerOpen(key, name, found.chain, point)
      ? found.def
      : null;
  }

  /** `seedAt`'s candidates by body: `key`'s and its kept prefixes' stores (`certifies` tells the `null` ones). */
  protected *seedLists(key: Key): Work<readonly ReadonlyMap<TreeBlock, Candidates>[]> {
    this.#work.charge("exactQueries");
    const lists = [yield* this.#ownCandidates(key, "null", [])];
    for (const prefix of each(this.#work, "eventSteps", keptPrefixes(this.#work, key)))
      lists.push(this.wholeStores(prefix));
    return lists;
  }

  /** Whether a candidate certifies `null`, through its copy source's own route where it copies one. */
  protected *certifies(found: Candidate, key: Key): Work<boolean> {
    this.#work.charge("exactQueries");
    const source = yield* this.#certificate(found, key, "null", []);
    return (
      source === true ||
      (source !== false && (yield* this.witness(source.key, source.tag, source.node)) !== null)
    );
  }

  /**
   * An exact definition D′ of `key` that certifies `tag` and reaches `node` without a check, or `null` when the
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
    const waiting: { readonly memo: string; readonly found: Candidate }[] = [];
    // (a program the default holds asks its own queries, apart from the unrestricted ones: `feasible`)
    let memo =
      this.feasible === null
        ? joinParts(key, node.id, tag, this.#othersText(others))
        : joinParts(key, node.id, tag, this.#othersText(others), "entered");
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
      if (source === true) {
        this.#witnesses.set(memo, found.def);
        answer = found.def;
        break;
      }
      waiting.push({ memo, found });
      ({ key, tag, node } = source);
      others = [];
      memo =
        this.feasible === null
          ? joinParts(key, node.id, tag, "")
          : joinParts(key, node.id, tag, "", "entered");
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
    const { program, handlers } = this.pass;
    if (!program.live(node)) return null;
    // (a read in a block's body examines the body's own stores, without the handler veto: r4-451's same-body route)
    const reached = program.blockReachable(node);
    const own = reached && this.inBody(node);
    if ((reached && !own) || node.span === null) return null;
    if (!own && handlers.handlerTouches(key) && this.#registered(node)) return null;
    return yield* this.#examinedAt(key, tag, node, null, node.span.start.offset, others);
  }

  /** `#examined` at a point given by its place (`chain`, else the node's own) and offset: a jump's, or a use's. */
  *#examinedAt(
    key: Key,
    tag: ItemTag,
    node: FlowNode,
    place: readonly Place[] | null,
    at: number,
    others: readonly ItemTag[],
    into: Entry | null = null,
  ): Work<Candidate | null> {
    this.#work.charge("exactQueries");
    const { program, contract } = this.pass;
    // positions and members are not facts: no element key and no reference member has a route
    const path = keyPath(key);
    // (`keyPath` walks the key's text)
    program.work.charge("eventSteps", path.length + 1);
    if (holds(program.work, "eventSteps", path, "element") || (yield* contract.refReceiver(key)))
      return null;
    const chain = place ?? this.chainOf(node);
    if (chain === null) return null;
    const body = chain[0]!.block;
    let best: Candidate | null = null;
    const consider = (lists: ReadonlyMap<TreeBlock, Candidates>): void => {
      program.work.charge("eventSteps");
      const candidates = lists.get(body);
      const found = candidates === undefined ? null : this.last(candidates, at);
      if (found !== null && (best === null || found.start > best.start)) best = found;
    };
    consider(yield* this.#ownCandidates(key, tag, others));
    for (const prefix of each(program.work, "eventSteps", keptPrefixes(program.work, key)))
      consider(this.wholeStores(prefix));
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
    return this.#open(key, tag, found, chain, node, into) ? found : null;
  }

  /** The handler veto's registration-before-read predicate. */
  #registered(node: FlowNode): boolean {
    this.#work.charge("eventSteps");
    this.#work.charge("eventSteps", node.loops.length);
    return this.pass.handlers.afterSomeCreation(node);
  }

  /**
   * Whether a candidate certifies the offending item for `key` (r4-444, #1073): `true`
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
    if (
      d.kind !== "whole" ||
      d.weak ||
      d.value === undefined ||
      !CERTIFIED.has(d.how) ||
      !lists.certain(d) ||
      // (a parameter's default is selected by a call that omits it, which a merged answer may not prove, #1938)
      (this.feasible !== null && d.how === "parameter default")
    )
      return false;
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
      if (c?.kind === "fallback" && literalTag(program, c.right) === tag) {
        const right = program.places[c.right]?.site;
        const fallback = right === undefined || right === null ? null : program.exprAt(right);
        if (fallback === null || !program.live(fallback)) return false;
        if (literalTag(program, c.left) === "null") return true;
        const read = this.#scalarRead(c.left);
        if (read !== null) return { key: read.key, tag: "null", node: read.node };
      }
    }
    const read = left.length === 0 ? this.#scalarRead(value) : null;
    if (read !== null) return { key: read.key, tag, node: read.node };
    // (in a program the default holds, only a `load`'s literal default proves itself, #1938)
    if (this.feasible !== null) return left.length === 0 && this.#ownLoad(value, tag, others);
    // (one answer per read, never a route per field of each copy)
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
    const producesAt = function* (
      at: PlaceId,
      kind: ItemTag,
      routes: NarrowingRoutes,
    ): Work<boolean> {
      program.work.charge("exactQueries");
      const literal = literalTag(program, at);
      if (literal !== null) return literal === kind;
      return produces(program.work, yield* routes.pass.values.valueItems(at, node, []), kind);
    };
    let nullable = yield* producesAt(left, "null", this);
    let produced = tag !== "null" && (yield* producesAt(left, tag, this));
    let index = rights.length;
    for (const _ of steps(program.work, "exactQueries", () => index > 0)) {
      index -= 1;
      const right = rights[index]!;
      if (!nullable) break;
      if (tag !== "null" && !produced) produced = yield* producesAt(right, tag, this);
      nullable = yield* producesAt(right, "null", this);
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
   * The corridor from a candidate to the read: the writer side up to the lowest block they share, the read's statement
   * after the candidate's there, the statements between, and each entered block's statements before the read's, all
   * open in both layers; no call-in a possible overwriter makes between the read's top statement and the read on every
   * route (the headers entered, the read's own statement); and one boundary.
   */
  #open(
    key: Key,
    tag: ItemTag,
    found: Candidate,
    chain: readonly Place[],
    node: FlowNode,
    into: Entry | null,
  ): boolean {
    this.#work.charge("eventSteps");
    const { program } = this.pass;
    const d = found.def;
    if (!program.live(d.node) || program.dom.edom(d.node) !== program.dom.edom(node)) return false;
    // (in a program the default holds, the writer and the use stand where a route may promote: `#plain`, or at the
    // entry a seed's jump makes, r4-451, the jump already standing there)
    if (
      this.feasible !== null &&
      (into === null
        ? !this.#plain(d.node, found.chain) || !this.#plain(node, chain)
        : !this.standsAt(into, d.node, found.chain))
    )
      return false;
    const hazards = into === null ? this.feasible?.hazards : this.feasible?.entryHazards;
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
    if (level >= writer.length || level >= chain.length) return false;
    const shared = writer[level]!.block;
    if (chain[level]!.block !== shared || chain[level]!.index <= writer[level]!.index) return false;
    let up = writer.length;
    for (const _ of steps(this.#work, "eventSteps", () => up - 1 > level)) {
      up -= 1;
      const { block, index } = writer[up]!;
      if (this.closed(block, index + 1, block.statements.length, layer, layer.calls)) return false;
      if (block.owner !== null && !this.leaves(block.owner, layer.calls)) return false;
      // (in a program the default holds, nothing after the writer in its block that a run might not pass, #1938)
      if (
        hazards !== undefined &&
        countIn(this.#work, hazards.get(block.id) ?? [], index + 1, block.statements.length) > 0
      )
        return false;
    }
    if (this.closed(shared, writer[level]!.index + 1, chain[level]!.index, layer, layer.calls))
      return false;
    let down = level + 1;
    for (const _ of steps(this.#work, "eventSteps", () => down < chain.length)) {
      const { block, index } = chain[down]!;
      if (this.closed(block, 0, index, layer, layer.calls)) return false;
      down += 1;
    }
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
   * A key's kill layer (the header's sparse per-key layer, its kills): the statements its own whole stores stand in,
   * and the compound statements they close beside the shared layer and its prefixes' kill layers; built once per key
   * and applicability, over the statements holding its own kills and their ancestors.
   */
  #killLayer(key: Key, calls: boolean): Layer {
    // (one unit per prefix the recursion climbs)
    this.#work.charge("indexSteps");
    const memo =
      this.feasible === null
        ? joinParts(key, calls ? "calls" : "leaves")
        : joinParts(key, calls ? "calls" : "leaves", "entered");
    const known = this.#layers.get(memo);
    if (known !== undefined) return known;
    const { program, definitions, lists } = this.pass;
    // (only the parent's text, made and charged once per key by the memo: the whole prefix list at every ancestor kept
    // a chain's text cubic, #1748)
    const prefix = keptParent(program.work, key);
    // (a root key's kills lie over the feasibility layer in a program the default holds)
    const parent =
      prefix !== null
        ? this.#killLayer(prefix, calls)
        : this.feasible === null
          ? null
          : this.#feasibilityLayer(calls);
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
    const memo = this.feasible === null ? joinParts(key, tag) : joinParts(key, tag, "entered");
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
   * In a program the default holds, the layer beneath every root kill layer (#1938): the arms no run is proved to enter
   * closed (`Feasibility.unentered`), and every compound statement whose live arms they and the shared layer close;
   * built once per applicability.
   */
  #feasibilityLayer(calls: boolean): Layer {
    this.#work.charge("indexSteps");
    const memo = joinParts("feasibility", calls ? "calls" : "leaves");
    const known = this.#layers.get(memo);
    if (known !== undefined) return known;
    const { unentered, owners } = this.feasible!;
    const layer = this.#build(null, calls, owners, (arm) => {
      this.#work.charge("indexSteps");
      return unentered.has(arm);
    });
    keepText(this.#work, memo.length);
    this.#layers.set(memo, layer);
    return layer;
  }

  /**
   * Whether a node stands where, in a program the default holds, a route may promote (#1938): in the top level of the
   * file the session starts in (no boundary dominates it, and its chain starts at a file's body), with every arm of its
   * chain one a run is proved to enter and none a loop's body, before it in each block of its chain only statements
   * `PASSABLE` admits that hold no call and no handler's declaration (`Feasibility.hazards`), and no statement of its
   * chain whose own expressions a run evaluates before going on, its own included, holding a call or a handler's
   * declaration (`Feasibility.headed`). Anything else keeps the warning: that a run reaches it there is not proved.
   */
  #plain(node: FlowNode, chain: readonly Place[]): boolean {
    this.#work.charge("eventSteps");
    return this.clear(this.feasible!, this.feasible!.hazards, node, chain, null);
  }

  /**
   * A `load` read where it is used, in a program the default holds (#1938): its literal default (`#ownLoad`) where the
   * use stands where a route may promote (`#plain`); the warning where the use has no node or no chain.
   */
  #inlineLoad(value: PlaceId, node: FlowNode | null, tag: ItemTag): boolean {
    this.#work.charge("exactQueries");
    const chain = node === null ? null : this.chainOf(node);
    return (
      node !== null && chain !== null && this.#plain(node, chain) && this.#ownLoad(value, tag, [])
    );
  }

  /**
   * A certificate by a `load` (#1938): a `load` whose default is a literal of the kind, in a program that saves under
   * neither its key nor a computed key, selects that default on a run whose storage holds no value under the key (V30
   * §25: the default is "the value to use while the key holds none"; only `save` creates a stored value), whatever
   * the program's other values hold.
   */
  #ownLoad(value: PlaceId, tag: ItemTag, others: readonly ItemTag[]): boolean {
    this.#work.charge("exactQueries");
    const program = this.pass.program;
    const c = program.opOf.get(value);
    if (c?.kind !== "load" || c.fallback === null) return false;
    const literal = literalTag(program, c.fallback);
    if (
      literal === null ||
      (literal !== tag && !some(this.#work, "exactQueries", others, (kind) => kind === literal))
    )
      return false;
    if (this.#saves === null) {
      const keys = new Set<string>();
      let computed = false;
      for (const constraint of each(this.#work, "indexSteps", program.constraints))
        if (constraint.kind === "save") {
          if (constraint.key === null) computed = true;
          else keys.add(constraint.key);
        }
      this.#saves = { keys, computed };
    }
    const { keys, computed } = this.#saves;
    return !computed && (c.key === null ? keys.size === 0 : !keys.has(c.key));
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
        some(
          work,
          "eventSteps",
          below(),
          (layer) => (layer.counts.get(arm.id) ?? 0) > 0 || layer.closedArms.has(arm),
        )
      );
    };
    const pending: TreeStatement[] = [];
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
    return { parent, statements, closed, counts, arms, calls, closedArms: counted };
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
    const memo =
      this.feasible === null
        ? joinParts(key, tag, this.#othersText(others))
        : joinParts(key, tag, this.#othersText(others), "entered");
    const known = this.candidates.get(memo);
    if (known !== undefined) return known;
    const layer = this.#testLayer(key, tag);
    const carrying: Definition[] = [];
    for (const d of each(this.#work, "indexSteps", this.pass.definitions.byKey.get(key) ?? []))
      if (yield* this.#carries(d, tag, others)) carrying.push(d);
    const made = this.candidateLists(carrying, layer, layer.calls);
    keepText(this.#work, memo.length);
    this.candidates.set(memo, made);
    return made;
  }

  /**
   * Whether a definition's own value could certify `tag`: a literal of that kind, else what the value holds where it is
   * stored (a copy's source as read there, any other producer's value), neither stopped nor read under a failed test
   * (r4-444: no producer is refused as such).
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
}
