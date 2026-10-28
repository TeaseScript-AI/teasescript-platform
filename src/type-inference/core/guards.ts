import type { Expression } from "../../ast.js";
import { expressionChildren, unwrap } from "../../expression-children.js";
import type { PlaceId } from "../graph.js";
import { conditionShape } from "../narrowing-shapes.js";
import { joinSteps, keptText } from "./budget.js";
import {
  keptKey,
  keptPrefixes,
  keyOf,
  keyPath,
  keyPlace,
  prefixesOf,
  recordKey,
  sortCost,
  type Key,
} from "./definitions.js";
import type { Callable, FlowNode } from "./flow-graph.js";
import type { Item } from "./items.js";
import type { CorePass } from "./answers.js";
import { NarrowingIndex } from "./narrowing.js";
import { NarrowingEvents } from "./narrowing-events.js";
import { NarrowingRoutes } from "./narrowing-routes.js";
import type { StatementTree } from "./narrowing-statements.js";
import { siteKey, stepName, type CoreProgram } from "./program.js";

/*
 * The guard index of the coarse core (checkpoint 9, TABLE §3.2 r4.6–r4.12): a read of key k is guarded inside a branch
 * of its own callable whose condition tests k or a path holding k (a null comparison, a type test or a comparison
 * `<`, `<=`, `>`, `>=`, at a truth position: through `and`, `or` and `not`; a `switch` on it), in the code after a
 * branch that tests it and always leaves (the way past the test is a branch entry of its own), and in the right operand
 * of an `and` or `or` whose left operand tests it. Guards are indexed per tested key, as definitions are: a read asks
 * its key and each prefix, a binary search each, never a root's other keys and never an `and` chain's other tests.
 * Stage 3b's narrowing definitions (§13, S10) join this index: built on their first read, once per program
 * (`NarrowingIndex`, N1 and N2's lists, and the statements with N3's shared layer, `StatementTree`), and asked per pass
 * through `narrowings` (N2 with N5, N3).
 * A read in a stored value takes its narrowing where it holds (`Values`, S10 part 2b); every other read still takes a
 * test as a guard until its consumer reads the narrowings (part 2c).
 */

/** A list of guard regions sorted by where they start, with the running maximum of where they end. */
interface Regions<T> {
  readonly list: readonly T[];
  readonly ends: readonly number[];
}

/** A region of an `and`/`or`'s right operands, from a test's end to the end of the outermost logical: text offsets. */
export interface OperandRegion {
  readonly start: number;
  readonly end: number;
}

/**
 * Guard regions of several tested keys, each labelled by its key's path below a common key, sorted by where they start:
 * laminar (two regions nest or lie apart: dominator subtrees, logical operands), so each has the nearest region holding
 * it and a skew-binary jump up that chain, along which the ends only grow (`#holding`). `laminar` is false where two
 * regions overlap without nesting; each label's own regions are then asked.
 */
interface Nest {
  readonly starts: readonly number[];
  readonly ends: readonly number[];
  readonly labels: readonly string[];
  readonly parents: readonly number[];
  readonly jumps: readonly number[];
  readonly laminar: boolean;
}

const COMPARISONS: ReadonlySet<string> = new Set(["<", "<=", ">", ">="]);

/** The operands a test at a truth position tests: a null comparison's, a type test's, a comparison's. */
function testedOperands(expression: Expression): readonly Expression[] {
  const shape = conditionShape(expression);
  if (shape.kind === "null") return [shape.node.left, shape.node.right];
  if (shape.kind === "type") return [shape.tested];
  const node = unwrap(expression);
  return node.kind === "binaryExpression" && COMPARISONS.has(node.operator)
    ? [node.left, node.right]
    : [];
}

export class GuardIndex {
  /** Per tested key and callable, the entries of the branches its tests guard. */
  readonly #branches = new Map<Key, Map<Callable | null, Regions<FlowNode>>>();
  /** Per tested key and file, the right-operand regions its tests guard. */
  readonly #operands = new Map<Key, Map<number, Regions<OperandRegion>>>();
  /** Per tested key, the callables its operand regions stand in (W40, r4.33). */
  readonly #operandCallables = new Map<Key, Set<Callable | null>>();
  /** The keys with a tested key strictly below them: a copy of one carries its read as a mark (§3.2 r4.15). */
  readonly belowTested = new Set<Key>();
  /** Per key, the tested keys strictly below it, and the guard regions of those keys once asked (`guardedBelow`). */
  readonly #testedUnder = new Map<Key, Key[]>();
  /** Per read, the tested paths below it whose regions hold it (`guardedBelowRead`). */
  readonly #belowReads = new Map<PlaceId, readonly string[]>();
  readonly #nests = new Map<
    Key,
    { readonly branches: Map<Callable | null, Nest>; readonly operands: Map<number, Nest> }
  >();
  /** The tested keys q below each key, per relative path q, and the longest such path (§8 r4.23's holders). */
  #testedRelative: Map<string, Set<Key>> | null = null;
  #byPlace: ReadonlyMap<PlaceId, ReadonlyMap<number, Regions<OperandRegion>>> | null = null;
  #testedLength = 0;
  #narrowing: NarrowingIndex | null = null;
  #queries: { readonly events: NarrowingEvents; readonly routes: NarrowingRoutes } | null = null;

  public constructor(readonly program: CoreProgram) {
    const work = program.work;
    const flow = program.flow;
    const branches = new Map<Key, Map<Callable | null, FlowNode[]>>();
    for (const [uses, conditions] of [
      [flow.conditionUses, true],
      [flow.switchUses, false],
    ] as const)
      for (const use of uses) {
        const node = program.exprAt({
          file: use.file,
          start: use.operand.span.start.offset,
          end: use.operand.span.end.offset,
        });
        if (node === null || !program.reached(node)) continue;
        // a condition guards the keys its tests test; a switch the key its subject is or holds
        const tested = conditions
          ? this.#testedIn(use.file, use.operand)
          : new Set([this.#testedKey(use.file, use.operand)].filter((key) => key !== undefined));
        for (const key of tested)
          for (const branch of use.branches)
            if (program.reached(branch)) {
              let byCallable = branches.get(key);
              if (byCallable === undefined) branches.set(key, (byCallable = new Map()));
              const callable = program.callableAt(branch);
              const list = byCallable.get(callable);
              if (list === undefined) byCallable.set(callable, [branch]);
              else list.push(branch);
            }
      }
    for (const [key, byCallable] of branches) {
      const sorted = new Map<Callable | null, Regions<FlowNode>>();
      for (const [callable, list] of byCallable) {
        work.charge("indexSteps", sortCost(list.length));
        list.sort((a, b) => program.position(a) - program.position(b));
        let last = -1;
        sorted.set(callable, {
          list,
          ends: list.map((node) => (last = Math.max(last, program.positionEnd(node)))),
        });
      }
      this.#branches.set(key, sorted);
    }
    this.#operandRegions();
    const listed = new Set<Key>();
    for (const key of [...this.#branches.keys(), ...this.#operands.keys()]) {
      const first = !listed.has(key);
      listed.add(key);
      for (const prefix of keptPrefixes(work, key)) {
        work.charge("indexSteps");
        this.belowTested.add(prefix);
        if (!first) continue;
        let keys = this.#testedUnder.get(prefix);
        if (keys === undefined) this.#testedUnder.set(prefix, (keys = []));
        keys.push(key);
      }
    }
  }

  /**
   * Stage 3b's narrowing definitions and invalidations (§13), built on their first read and charged then: an analysis
   * that reads none pays for none (TABLE r4.117; no consumer reads them before S10's second part).
   */
  public get narrowing(): NarrowingIndex {
    return (this.#narrowing ??= NarrowingIndex.of(this.program));
  }

  /** Stage 3b's statements with N3's shared layer (`narrowing`'s). */
  public get statements(): StatementTree {
    return this.narrowing.statements;
  }

  /** Stage 3b's queries of this pass (§13): N2's events with N5's preserving stores, and N3's routes. */
  public narrowings(pass: CorePass): {
    readonly events: NarrowingEvents;
    readonly routes: NarrowingRoutes;
  } {
    if (this.#queries === null)
      this.#queries = {
        events: new NarrowingEvents(pass, this.narrowing),
        routes: new NarrowingRoutes(pass, this.narrowing, this.statements),
      };
    return this.#queries;
  }

  /**
   * §3.2 at a read of `key` in `node`: the paths below `key`, relative to it, of the tested keys whose guard regions
   * hold the node, each only where no shorter one of them holds it (that one marks every path below it already). Per
   * key, the regions of every tested key below it, laminar: a binary search, a jump to the innermost region holding the
   * node, and the regions holding that one, never each tested key in turn (Codex r21 B1).
   */
  public guardedBelow(key: Key, node: FlowNode): readonly string[] {
    const program = this.program;
    if (!program.reached(node)) return [];
    const nests = this.#nestsBelow(recordKey(key));
    if (nests === null) return [];
    const held = new Set<string>();
    const branches = nests.branches.get(program.callableAt(node));
    if (branches !== undefined) this.#holding(branches, program.position(node), held);
    const operands = node.span === null ? undefined : nests.operands.get(node.file);
    if (operands !== undefined && node.span !== null)
      this.#holding(operands, node.span.start.offset, held);
    const out: string[] = [];
    for (const path of held) {
      let shorter = false;
      for (let cut = path.indexOf("."); cut >= 0 && !shorter; cut = path.indexOf(".", cut + 1)) {
        program.work.charge("eventSteps");
        shorter = held.has(path.slice(0, cut));
      }
      if (!shorter) out.push(path);
    }
    program.work.charge("eventSteps", sortCost(out.length));
    return out.sort();
  }

  /**
   * `guardedBelow` at a value's read below its property and element projections (as `guardedRead`), once per read and
   * pass: every caller asking of one read shares its answer (Codex r22 F4).
   */
  public guardedBelowRead(value: PlaceId): readonly string[] {
    const known = this.#belowReads.get(value);
    if (known !== undefined) return known;
    const answer = this.#guardedBelowRead(value);
    this.#belowReads.set(value, answer);
    return answer;
  }

  #guardedBelowRead(value: PlaceId): readonly string[] {
    const program = this.program;
    const steps: string[] = [];
    let current = value;
    for (let projection = program.projOf.get(current); projection !== undefined;) {
      steps.push(projection.step === "iteration" ? "element" : stepName(projection.step));
      current = projection.owner;
      projection = program.projOf.get(current);
    }
    const binding = program.occurrenceOf.get(current);
    const node = program.occNode.get(current);
    if (binding === undefined || node === undefined || node === null) return [];
    return this.guardedBelow(keyOf(binding, steps.reverse()), node);
  }

  /** The regions of the tested keys strictly below `key`, by callable and by file, built once per key asked. */
  #nestsBelow(
    key: Key,
  ): {
    readonly branches: Map<Callable | null, Nest>;
    readonly operands: Map<number, Nest>;
  } | null {
    const known = this.#nests.get(key);
    if (known !== undefined) return known;
    const under = this.#testedUnder.get(key);
    if (under === undefined) return null;
    const program = this.program;
    const depth = keyPath(key).length;
    type Entry = { readonly start: number; readonly end: number; readonly label: string };
    const branches = new Map<Callable | null, Entry[]>();
    const operands = new Map<number, Entry[]>();
    const add = <K>(into: Map<K, Entry[]>, at: K, entry: Entry): void => {
      program.work.charge("indexSteps");
      const list = into.get(at);
      if (list === undefined) into.set(at, [entry]);
      else list.push(entry);
    };
    for (const tested of under) {
      const label = keptText(program.work, keyPath(tested).slice(depth));
      for (const [callable, regions] of this.#branches.get(tested) ?? [])
        for (const entry of regions.list)
          add(branches, callable, {
            start: program.position(entry),
            end: program.positionEnd(entry),
            label,
          });
      for (const [file, regions] of this.#operands.get(tested) ?? [])
        for (const region of regions.list)
          add(operands, file, { start: region.start, end: region.end, label });
    }
    const nests = {
      branches: new Map([...branches].map(([at, list]) => [at, this.#nest(list)] as const)),
      operands: new Map([...operands].map(([at, list]) => [at, this.#nest(list)] as const)),
    };
    this.#nests.set(key, nests);
    return nests;
  }

  /** Sorts regions by where they start (the longer first) and links each to the nearest one holding it. */
  #nest(entries: { readonly start: number; readonly end: number; readonly label: string }[]): Nest {
    const work = this.program.work;
    work.charge("indexSteps", sortCost(entries.length));
    entries.sort((a, b) => a.start - b.start || b.end - a.end);
    const parents: number[] = [];
    const jumps: number[] = [];
    const depths: number[] = [];
    const open: number[] = [];
    let laminar = true;
    for (const [index, entry] of entries.entries()) {
      work.charge("indexSteps");
      while (open.length > 0 && entries[open.at(-1)!]!.end < entry.start) open.pop();
      const parent = open.at(-1) ?? -1;
      if (parent >= 0 && entries[parent]!.end < entry.end) laminar = false;
      parents.push(parent);
      depths.push(parent < 0 ? 0 : depths[parent]! + 1);
      // (Myers's skew-binary jumps: an ancestor search in logarithmic steps)
      const up = parent < 0 ? -1 : jumps[parent]!;
      const further = up < 0 ? -1 : jumps[up]!;
      jumps.push(
        further >= 0 && depths[parent]! - depths[up]! === depths[up]! - depths[further]!
          ? further
          : parent,
      );
      open.push(index);
    }
    return {
      starts: entries.map((entry) => entry.start),
      ends: entries.map((entry) => entry.end),
      labels: entries.map((entry) => entry.label),
      parents,
      jumps,
      laminar,
    };
  }

  /** Adds the labels of a nest's regions holding `at` to `held`: the last region starting by `at`, up to one holding it. */
  #holding(nest: Nest, at: number, held: Set<string>): void {
    const work = this.program.work;
    let low = 0;
    let high = nest.starts.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      work.charge("eventSteps");
      if (nest.starts[middle]! <= at) low = middle + 1;
      else high = middle;
    }
    if (!nest.laminar) {
      for (let index = 0; index < low; index += 1) {
        work.charge("eventSteps");
        if (nest.ends[index]! >= at) held.add(nest.labels[index]!);
      }
      return;
    }
    // (up the chain the regions end no earlier: a jump whose region ends before `at` passes every region below it)
    let index = low - 1;
    while (index >= 0 && nest.ends[index]! < at) {
      work.charge("eventSteps");
      const jump = nest.jumps[index]!;
      index = jump >= 0 && nest.ends[jump]! < at ? nest.parents[jump]! : nest.parents[index]!;
    }
    for (; index >= 0; index = nest.parents[index]!) {
      work.charge("eventSteps");
      held.add(nest.labels[index]!);
    }
  }

  /**
   * The key a tested operand is or holds (§3.2 "a path holding k"): an identifier, or a property or element read below
   * one (`box.left`: the key `box.left`; a path the places do not resolve: the whole variable).
   */
  #testedKey(file: number, expression: Expression): Key | undefined {
    const program = this.program;
    const top = unwrap(expression);
    let root = top;
    while (root.kind === "propertyAccessExpression" || root.kind === "indexExpression")
      root = unwrap(root.object);
    if (root.kind !== "identifier") return undefined;
    const occurrence = program.placeBySite.get(
      siteKey({ file, start: root.span.start.offset, end: root.span.end.offset }),
    );
    const binding = occurrence === undefined ? undefined : program.occurrenceOf.get(occurrence);
    if (binding === undefined) return undefined;
    const value =
      root === top
        ? undefined
        : program.placeBySite.get(
            siteKey({ file, start: top.span.start.offset, end: top.span.end.offset }),
          );
    const target =
      value !== undefined && program.projOf.has(value) ? program.targetRoot(value) : null;
    return keyOf(binding, target !== null && target.root === binding ? target.path : []);
  }

  #testedBy(file: number, expression: Expression): Key[] {
    return testedOperands(expression)
      .map((operand) => this.#testedKey(file, operand))
      .filter((key) => key !== undefined);
  }

  /** The keys a condition tests at its truth positions: through `and`, `or` and `not`. */
  #testedIn(file: number, condition: Expression): Set<Key> {
    const keys = new Set<Key>();
    const pending = [condition];
    while (pending.length > 0) {
      const expression = pending.pop()!;
      this.program.work.charge("indexSteps");
      const shape = conditionShape(expression);
      if (shape.kind === "and" || shape.kind === "or") pending.push(shape.left, shape.right);
      else if (shape.kind === "not") pending.push(shape.operand);
      else for (const key of this.#testedBy(file, expression)) keys.add(key);
    }
    return keys;
  }

  /**
   * §3.2 (r4.12): a test at a truth position of an `and`/`or`'s left operand guards the code after it up to the end of
   * the outermost `and`/`or` in whose left operand it stands. One walk of each outermost logical tree, with an explicit
   * stack: a test is one region per key it tests. The operands of any other expression are no truth positions: a
   * logical below one is a tree of its own.
   */
  #operandRegions(): void {
    const program = this.program;
    const work = program.work;
    const logicals = [...program.flow.logicals].sort(
      (a, b) =>
        a.file - b.file ||
        a.expression.span.start.offset - b.expression.span.start.offset ||
        b.expression.span.end.offset - a.expression.span.end.offset,
    );
    work.charge("indexSteps", sortCost(logicals.length));
    const regions = new Map<Key, Map<number, OperandRegion[]>>();
    let outer: (typeof logicals)[number] | null = null;
    for (const logical of logicals) {
      if (
        outer !== null &&
        outer.file === logical.file &&
        logical.expression.span.end.offset <= outer.expression.span.end.offset
      )
        continue;
      outer = logical;
      const file = logical.file;
      const node = program.exprAt({
        file,
        start: logical.expression.span.start.offset,
        end: logical.expression.span.end.offset,
      });
      const callable = node === null ? null : program.callableAt(node);
      const pending: { readonly expression: Expression; readonly reach: number | null }[] = [
        { expression: logical.expression, reach: null },
      ];
      while (pending.length > 0) {
        const { expression, reach } = pending.pop()!;
        work.charge("indexSteps");
        const shape = conditionShape(expression);
        if (shape.kind === "and" || shape.kind === "or") {
          pending.push({ expression: shape.right, reach });
          pending.push({ expression: shape.left, reach: reach ?? shape.node.span.end.offset });
          continue;
        }
        if (shape.kind === "not") {
          pending.push({ expression: shape.operand, reach });
          continue;
        }
        const top = unwrap(expression);
        if (reach !== null)
          for (const key of this.#testedBy(file, top)) {
            let byFile = regions.get(key);
            if (byFile === undefined) regions.set(key, (byFile = new Map()));
            const list = byFile.get(file);
            const region = { start: top.span.end.offset, end: reach };
            if (list === undefined) byFile.set(file, [region]);
            else list.push(region);
            let callables = this.#operandCallables.get(key);
            if (callables === undefined) this.#operandCallables.set(key, (callables = new Set()));
            callables.add(callable);
          }
        for (const child of expressionChildren(top))
          pending.push({ expression: child, reach: null });
      }
    }
    for (const [key, byFile] of regions) {
      const sorted = new Map<number, Regions<OperandRegion>>();
      for (const [file, list] of byFile) {
        work.charge("indexSteps", sortCost(list.length));
        list.sort((a, b) => a.start - b.start);
        let last = -1;
        sorted.set(file, { list, ends: list.map((region) => (last = Math.max(last, region.end))) });
      }
      this.#operands.set(key, sorted);
    }
  }

  /** Whether the last of a sorted list starting at most at `at` begins a region reaching `at`: a binary search. */
  public encloses<T>(regions: Regions<T>, start: (entry: T) => number, at: number): boolean {
    let low = 0;
    let high = regions.list.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      this.program.work.charge("eventSteps");
      if (start(regions.list[middle]!) <= at) low = middle + 1;
      else high = middle;
    }
    return low > 0 && regions.ends[low - 1]! >= at;
  }

  /** The branch entries a test of `key` guards in `callable`. */
  public branchesOf(key: Key, callable: Callable | null): Regions<FlowNode> | undefined {
    return this.#branches.get(key)?.get(callable);
  }

  /** The operand regions a test of `key` guards in `file`. */
  public operandsOf(key: Key, file: number): Regions<OperandRegion> | undefined {
    return this.#operands.get(key)?.get(file);
  }

  /** The callables in which a test of `key` guards a branch. */
  public branchCallables(key: Key): ReadonlyMap<Callable | null, unknown> | undefined {
    return this.#branches.get(key);
  }

  /** The callables in which a test of `key` guards an operand region. */
  public operandCallables(key: Key): ReadonlySet<Callable | null> | undefined {
    return this.#operandCallables.get(key);
  }

  /**
   * Whether a read of `key` at `node` is guarded (§3.2, per path): a test of the key or of a prefix guards a branch of
   * the node's own callable that dominates the node, or an operand region holds the node: a binary search per key asked,
   * the key and each prefix (r4.12); a choice's selection step as the record key it reads.
   */
  public narrowed(key: Key, node: FlowNode): boolean {
    const program = this.program;
    if (!program.reached(node)) return false;
    const asked = recordKey(key);
    for (const tested of [asked, ...prefixesOf(asked)]) {
      program.work.charge("eventSteps");
      const branches = this.#branches.get(tested)?.get(program.callableAt(node));
      if (
        branches !== undefined &&
        this.encloses(branches, (entry) => program.position(entry), program.position(node))
      )
        return true;
      const regions = node.span === null ? undefined : this.#operands.get(tested)?.get(node.file);
      if (
        regions !== undefined &&
        node.span !== null &&
        this.encloses(regions, (region) => region.start, node.span.start.offset)
      )
        return true;
    }
    return false;
  }

  /** Whether a branch a test of exactly `key` guards in a reached node's own callable holds it (§3.2). */
  public branchHolds(key: Key, node: FlowNode): boolean {
    const program = this.program;
    if (!program.reached(node)) return false;
    const branches = this.#branches.get(key)?.get(program.callableAt(node));
    return (
      branches !== undefined &&
      this.encloses(branches, (entry) => program.position(entry), program.position(node))
    );
  }

  /** Every branch a test guards: its tested key, the callable it stands in, and its entry (W34's copy forest). */
  public *branchRegions(): Generator<{
    readonly key: Key;
    readonly callable: Callable | null;
    readonly entry: FlowNode;
  }> {
    for (const [key, byCallable] of this.#branches)
      for (const [callable, regions] of byCallable)
        for (const entry of regions.list) yield { key, callable, entry };
  }

  /** Every tested key's operand regions in each file, sorted by where they start (W34's copy forest). */
  public *operandRegions(): Generator<{
    readonly key: Key;
    readonly file: number;
    readonly regions: readonly OperandRegion[];
  }> {
    for (const [key, byFile] of this.#operands)
      for (const [file, regions] of byFile) yield { key, file, regions: regions.list };
  }

  /**
   * Whether an operand region of a test of some key of the place holds a node (W34 r4.38: a copy read there may carry
   * a mark of its source, which `narrowed` then asks at the read's path): a binary search in the place's regions,
   * merged once from the per-key ones, never a scan of the place's tested paths.
   */
  public operandAround(place: PlaceId, node: FlowNode): boolean {
    const program = this.program;
    if (!program.reached(node) || node.span === null) return false;
    const regions = this.#placeOperands().get(place)?.get(node.file);
    program.work.charge("eventSteps");
    return (
      regions !== undefined &&
      this.encloses(regions, (region) => region.start, node.span.start.offset)
    );
  }

  /** The operand regions of each place's tests per file, merged from the per-key ones and sorted, once. */
  #placeOperands(): ReadonlyMap<PlaceId, ReadonlyMap<number, Regions<OperandRegion>>> {
    if (this.#byPlace !== null) return this.#byPlace;
    const program = this.program;
    const lists = new Map<PlaceId, Map<number, OperandRegion[]>>();
    for (const [key, byFile] of this.#operands)
      for (const [file, regions] of byFile) {
        program.work.charge("indexSteps", regions.list.length);
        let byPlace = lists.get(keyPlace(key));
        if (byPlace === undefined) lists.set(keyPlace(key), (byPlace = new Map()));
        const list = byPlace.get(file);
        if (list === undefined) byPlace.set(file, [...regions.list]);
        // (one by one: a place's operand regions grow with the source, past one call's arguments)
        else for (const region of regions.list) list.push(region);
      }
    const merged = new Map<PlaceId, Map<number, Regions<OperandRegion>>>();
    for (const [place, byFile] of lists) {
      const sorted = new Map<number, Regions<OperandRegion>>();
      for (const [file, list] of byFile) {
        program.work.charge("indexSteps", sortCost(list.length));
        list.sort((x, y) => x.start - y.start);
        let last = -1;
        sorted.set(file, { list, ends: list.map((region) => (last = Math.max(last, region.end))) });
      }
      merged.set(place, sorted);
    }
    this.#byPlace = merged;
    return merged;
  }

  /**
   * Whether a value is read under a guard of its key: the read below its property and element projections, at the path
   * `rest` read further (§3.2).
   */
  public guardedRead(value: PlaceId, rest: readonly string[] = []): boolean {
    const program = this.program;
    const steps: string[] = [];
    let current = value;
    for (let projection = program.projOf.get(current); projection !== undefined;) {
      steps.push(projection.step === "iteration" ? "element" : stepName(projection.step));
      current = projection.owner;
      projection = program.projOf.get(current);
    }
    const binding = program.occurrenceOf.get(current);
    const node = program.occNode.get(current);
    if (binding === undefined || node === undefined || node === null) return false;
    return this.narrowed(keyOf(binding, joinSteps(steps.reverse(), rest)), node);
  }

  /** The tested keys `q` below each key, per relative path `q` (every split of every tested key's path). */
  public testedBelow(relative: string): ReadonlySet<Key> | undefined {
    return this.#relative().get(relative);
  }

  /** The longest path of a tested key below another key. */
  public testedLength(): number {
    this.#relative();
    return this.#testedLength;
  }

  #relative(): Map<string, Set<Key>> {
    if (this.#testedRelative !== null) return this.#testedRelative;
    const relative = new Map<string, Set<Key>>();
    for (const tested of new Set([...this.#branches.keys(), ...this.#operands.keys()])) {
      const path = keyPath(tested);
      this.#testedLength = Math.max(this.#testedLength, path.length);
      for (let length = 0; length < path.length; length += 1) {
        this.program.work.charge("indexSteps");
        const below = keptText(this.program.work, path.slice(length));
        let keys = relative.get(below);
        if (keys === undefined) relative.set(below, (keys = new Set()));
        keys.add(keptKey(this.program.work, keyPlace(tested), path.slice(0, length)));
      }
    }
    this.#testedRelative = relative;
    return relative;
  }
}

/**
 * The items of a guarded read (§3.2 r4.6): every kind possible and marked, so no consumer errs on it; a known kind the
 * exact path answered without a word of its own takes `branch`, the test's; the emptiness mark stays as it is.
 */
export function marked(items: readonly Item[]): Item[] {
  return items.map((item) =>
    item.tag === "empty"
      ? item
      : {
          ...item,
          cert: "pos",
          guarded: true,
          context:
            item.context ?? (item.tag === "unknown" || item.word !== undefined ? null : "branch"),
        },
  );
}
