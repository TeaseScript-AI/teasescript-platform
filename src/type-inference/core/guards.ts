import type { Expression } from "../../ast.js";
import { expressionChildren, unwrap } from "../../expression-children.js";
import type { PlaceId } from "../graph.js";
import { conditionShape } from "../narrowing-shapes.js";
import {
  keyOf,
  keyPlace,
  keyPath,
  prefixesOf,
  recordKey,
  sortCost,
  type Key,
} from "./definitions.js";
import type { Callable, FlowNode } from "./flow-graph.js";
import type { Item } from "./items.js";
import { siteKey, stepName, type CoreProgram } from "./program.js";

/*
 * The guard index of the coarse core (checkpoint 9, TABLE §3.2 r4.6–r4.12): a read of key k is guarded inside a branch
 * of its own callable whose condition tests k or a path holding k (a null comparison, a type test or a comparison
 * `<`, `<=`, `>`, `>=`, at a truth position: through `and`, `or` and `not`; a `switch` on it), in the code after a
 * branch that tests it and always leaves (the way past the test is a branch entry of its own), and in the right operand
 * of an `and` or `or` whose left operand tests it. Guards are indexed per tested key, as definitions are: a read asks
 * its key and each prefix, a binary search each, never a root's other keys and never an `and` chain's other tests.
 * Stage 3b's narrowing definitions (§13, S10) join this index; until then every test is a guard.
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
  readonly #testedPaths = new Map<Key, (readonly string[])[]>();
  /** The tested keys q below each key, per relative path q, and the longest such path (§8 r4.23's holders). */
  #testedRelative: Map<string, Set<Key>> | null = null;
  #byPlace: ReadonlyMap<PlaceId, ReadonlyMap<number, Regions<OperandRegion>>> | null = null;
  #testedLength = 0;

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
      for (const prefix of prefixesOf(key)) {
        work.charge("indexSteps");
        this.belowTested.add(prefix);
        if (!first) continue;
        let paths = this.#testedPaths.get(prefix);
        if (paths === undefined) this.#testedPaths.set(prefix, (paths = []));
        paths.push(keyPath(key).slice(keyPath(prefix).length));
      }
    }
  }

  /** The paths below `key`, relative to it, of the tested keys strictly below it (§3.2: where a read of it is marked). */
  public testedPathsBelow(key: Key): readonly (readonly string[])[] {
    return this.#testedPaths.get(key) ?? [];
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
        else list.push(...regions.list);
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
    return this.narrowed(keyOf(binding, [...steps.reverse(), ...rest]), node);
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
        const below = path.slice(length).join(".");
        let keys = relative.get(below);
        if (keys === undefined) relative.set(below, (keys = new Set()));
        keys.add(keyOf(keyPlace(tested), path.slice(0, length)));
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
