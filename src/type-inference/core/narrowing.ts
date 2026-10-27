import type { Expression, TypeAnnotation } from "../../ast.js";
import { expressionChildren, unwrap } from "../../expression-children.js";
import { dictMethod } from "../../dict-operations.js";
import { listMethod } from "../../list-methods.js";
import { caseValueKey } from "../../switch-cases.js";
import type { ValueKind } from "../../value-kinds.js";
import type { PlaceId } from "../graph.js";
import { conditionShape } from "../narrowing-shapes.js";
import { joinParts, keepText, keptArray, keptParts, keptSteps, type WorkLedger } from "./budget.js";
import { keyBelow, keyOf, sortCost, type Key } from "./definitions.js";
import type { Callable, FlowNode } from "./flow-graph.js";
import { mergeItems, type Item, type ItemScope, type ItemTag } from "./items.js";
import { selectsElement } from "./method-categories.js";
import { propertyStep, siteKey, type CoreProgram } from "./program.js";
import { StatementTree } from "./narrowing-statements.js";

/*
 * Stage 3b's narrowing definitions (checkpoint 9, TABLE §13 N1, N2, §13.3): a test is a definition. A null test or a
 * type test of a stable path at a truth position defines the path at the guarded region's entry (a branch, a `while`
 * body, a `switch` case, the right operand of an `and` or `or`, and so the code after a branch that always leaves,
 * which the way past the test dominates) with the kinds the test leaves. Each narrowing definition G is one entry in its
 * refined location's sorted list, its value one filter of the read at the test (`narrowedItems`); a read finds the
 * nearest G of its own path text and of each element-step scope by a binary search and a jump up the list's nest
 * (`NarrowingIndex.nearest`), never by scanning sibling paths. The mutating method calls of a collection key are one
 * sorted invalidation list per key (N2). Everything here is built once from the program; what the definitions and the
 * handlers decide is asked per pass (`narrowing-events.ts`, `narrowing-routes.ts`).
 */

/** A step of a stable path (N1): a property, a fixed index or key, or an index or key held in a plain variable. */
export type PathStep =
  | { readonly kind: "property"; readonly name: string }
  | { readonly kind: "fixed"; readonly text: string }
  | { readonly kind: "variable"; readonly place: PlaceId }
  /** An element read by a computed index or `.random`: no test's path holds one; a read's trailing ones find scopes. */
  | { readonly kind: "element" };

/** A path below a binding, as the source writes it. */
export interface StablePath {
  readonly root: PlaceId;
  readonly steps: readonly PathStep[];
}

/** A step's text in a refined location: `.n`, `[0]`, `["key"]`, `[@12]` (an index variable's place), `[*]`. */
function stepLabel(step: PathStep): string {
  switch (step.kind) {
    case "property":
      return `.${step.name}`;
    case "fixed":
      return `[${step.text}]`;
    case "variable":
      return `[@${step.place}]`;
    case "element":
      return "[*]";
  }
}

/** Whether a step reads an element of a collection: an index, a key, or a selection (`first`, `last`, `random`). */
function readsElement(step: PathStep): boolean {
  return step.kind !== "property" || selectsElement(step.name);
}

/** The contract key a path's read asks (§1: every index, key and selection is `element`). */
export function pathKey(path: StablePath, length = path.steps.length): Key {
  const steps: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const step = path.steps[index]!;
    steps.push(
      step.kind === "property" && !readsElement(step) ? propertyStep(step.name) : "element",
    );
  }
  return keyOf(path.root, steps);
}

/**
 * The stable path an expression reads (N1): a binding followed by properties, fixed indexes or keys, and indexes or
 * keys held in plain variables; with `trailing`, any element reads at its end (a computed index, `.random`), which only
 * an element scope finds. `null` for anything else: a call, a literal, a path through a computed index, a speaker. An
 * assignment's target names its `root`, which it does not read.
 */
export function stablePath(
  program: CoreProgram,
  file: number,
  expression: Expression,
  trailing = false,
  root: PlaceId | null = null,
): StablePath | null {
  const steps: PathStep[] = [];
  let current = unwrap(expression);
  // (outermost first; reversed once the root is found)
  while (current.kind !== "identifier") {
    program.work.charge("eventSteps");
    if (current.kind === "propertyAccessExpression") {
      const name = current.property.name;
      if (name === "random") {
        if (!trailing || steps.some((step) => step.kind !== "element")) return null;
        steps.push({ kind: "element" });
      } else steps.push({ kind: "property", name });
      current = unwrap(current.object);
      continue;
    }
    if (current.kind !== "indexExpression") return null;
    const index = unwrap(current.index);
    const fixed = caseValueKey(index);
    const variable = index.kind === "identifier" ? bindingOf(program, file, index) : null;
    if (fixed !== undefined && (fixed.startsWith("number:") || fixed.startsWith("string:")))
      steps.push({ kind: "fixed", text: fixed });
    else if (variable !== null) steps.push({ kind: "variable", place: variable });
    else if (trailing && steps.every((step) => step.kind === "element"))
      steps.push({ kind: "element" });
    else return null;
    current = unwrap(current.object);
  }
  const binding = root ?? bindingOf(program, file, current);
  if (binding === null) return null;
  return { root: binding, steps: steps.reverse() };
}

/** The binding an identifier reads: a `let`, `global`, loop variable or parameter. */
function bindingOf(program: CoreProgram, file: number, identifier: Expression): PlaceId | null {
  const occurrence = program.placeBySite.get(
    siteKey({ file, start: identifier.span.start.offset, end: identifier.span.end.offset }),
  );
  const binding = occurrence === undefined ? undefined : program.occurrenceOf.get(occurrence);
  const kind = binding === undefined ? undefined : program.places[binding]?.kind.kind;
  return kind === "binding" || kind === "parameter" ? binding! : null;
}

/**
 * What a narrowing leaves (N1): `non-null` (`!= null`, `is not null`, a `default` or later case after `case null`),
 * `null` (`== null`, `is null`, `case null`), `is` a type (each item replaced by its overlap with the type's kinds; a
 * whole-valued numeric case as `is integer`, a fractional one as `is number` without `integer`, a text case as `is
 * string`), or `is-not` a type (only items wholly within its kinds removed).
 */
export type NarrowingForm =
  | { readonly kind: "non-null" }
  | { readonly kind: "null" }
  | { readonly kind: "is"; readonly kinds: readonly ValueKind[]; readonly fractional?: true }
  | { readonly kind: "is-not"; readonly kinds: readonly ValueKind[] };

const NON_NULL: NarrowingForm = { kind: "non-null" };
const ONLY_NULL: NarrowingForm = { kind: "null" };

/** Whether an item of kind `tag` lies wholly within `kinds` (an integer is a number). */
function within(tag: ItemTag, kinds: readonly ValueKind[]): boolean {
  return kinds.some((kind) => kind === tag || (tag === "integer" && kind === "number"));
}

/** The kind an item of kind `tag` keeps under a positive test of `kind`, or `null` when they are disjoint. */
function overlap(tag: ItemTag, kind: ValueKind, fractional: boolean): ItemTag | null {
  if (tag === "unknown") return kind;
  if (fractional) return tag === "number" ? "number" : null;
  if (tag === kind) return tag;
  // a whole number passes `is integer`; an integer is a number
  if (tag === "number" && kind === "integer") return "integer";
  if (tag === "integer" && kind === "number") return "integer";
  return null;
}

/**
 * G's value (N1): the input items filtered by the form. Emptiness (`empty`) is untouched; after a positive test,
 * `!= null` or `is not null`, a single remaining kind without `unknown` is definite; after `is not T` certainties stay.
 * An empty result is the unreachable branch's value.
 */
export function narrowedItems(
  form: NarrowingForm,
  items: readonly Item[],
  scope: ItemScope,
): Item[] {
  scope.work.charge("mergeItems", items.length + 1);
  const kept: Item[] = [];
  for (const item of items) {
    if (item.tag === "empty") {
      kept.push(item);
      continue;
    }
    switch (form.kind) {
      case "non-null":
        if (item.tag !== "null") kept.push(item);
        break;
      case "null":
        if (item.tag === "null" || item.tag === "unknown") kept.push({ ...item, tag: "null" });
        break;
      case "is":
        scope.work.charge("mergeItems", form.kinds.length);
        for (const kind of form.kinds) {
          const tag = overlap(item.tag, kind, form.fractional === true);
          if (tag !== null) kept.push(tag === item.tag ? item : { ...item, tag });
        }
        break;
      case "is-not":
        if (item.tag === "unknown" || !within(item.tag, form.kinds)) kept.push(item);
        break;
    }
  }
  const merged = mergeItems(kept, scope);
  if (form.kind === "is-not") return merged;
  const kinds = merged.filter((item) => item.tag !== "empty");
  if (kinds.length !== 1 || kinds[0]!.tag === "unknown" || kinds[0]!.cert === "def") return merged;
  return merged.map((item) => (item === kinds[0] ? { ...item, cert: "def" } : item));
}

/** Whether a narrowing of this form removes items of kind `tag` (a G of the needed form for N3's offending kind). */
export function removes(form: NarrowingForm, tag: ItemTag): boolean {
  switch (form.kind) {
    case "non-null":
      return tag === "null";
    case "null":
      return tag !== "null";
    case "is":
      return form.kinds.every((kind) => overlap(tag, kind, form.fractional === true) === null);
    case "is-not":
      return within(tag, form.kinds);
  }
}

/**
 * A type test's type: its kinds; the collection kinds it names with an element type (`integer[]`: `list`), which a
 * negative test never removes (only items wholly within the tested type are); and, for a single collection type beside
 * `null` alone, the type its element step names. Walked with an explicit stack: a type nests as deep as it is written.
 */
interface TestedType {
  readonly kinds: readonly ValueKind[];
  readonly constrained: ReadonlySet<ValueKind>;
  readonly element: TypeAnnotation | null;
}

function testedType(annotation: TypeAnnotation, work: WorkLedger): TestedType {
  const kinds: ValueKind[] = [];
  const constrained = new Set<ValueKind>();
  const elements: TypeAnnotation[] = [];
  let others = 0;
  const pending = [annotation];
  while (pending.length > 0) {
    const type = pending.pop()!;
    work.charge("indexSteps");
    switch (type.kind) {
      case "namedType":
        kinds.push(type.name);
        if (type.name !== "null") others += 1;
        break;
      case "listType":
      case "setType":
      case "dictType": {
        const kind = type.kind === "listType" ? "list" : type.kind === "setType" ? "set" : "dict";
        kinds.push(kind);
        constrained.add(kind);
        elements.push(type.element);
        break;
      }
      case "optionalType":
        kinds.push("null");
        pending.push(type.value);
        break;
      case "unionType":
        for (const member of type.members) pending.push(member);
        break;
    }
  }
  return {
    kinds,
    constrained,
    element: elements.length === 1 && others === 0 ? elements[0]! : null,
  };
}

/**
 * A test form at a truth position (N1): the tested expression, the test (a null test, or a type test with its type),
 * and the outcome a region takes: `true` where the test holds (`x == null`, `x is T`), `false` where it fails.
 */
interface Fact {
  readonly tested: Expression;
  readonly type: TestedType | null;
  readonly holds: boolean;
}

/** The complement arm, an `or`'s right operand, the way past a leave: the opposite outcome. */
function opposite(fact: Fact): Fact {
  return { ...fact, holds: !fact.holds };
}

/**
 * What a fact's outcome leaves (N1): `null` alone or every item but `null` for a null test; for a type test that holds,
 * each item's overlap with the type, and an element step's test per element type the type names; for one that fails,
 * only the items wholly within the type removed (never a collection kind the type names with an element type).
 */
function formOf(fact: Fact): {
  readonly form: NarrowingForm;
  readonly element: TypeAnnotation | null;
} {
  const type = fact.type;
  if (type === null) return { form: fact.holds ? ONLY_NULL : NON_NULL, element: null };
  return fact.holds
    ? { form: { kind: "is", kinds: type.kinds }, element: type.element }
    : {
        form: { kind: "is-not", kinds: type.kinds.filter((kind) => !type.constrained.has(kind)) },
        element: null,
      };
}

/**
 * A test form (N1): a null test or a type test, or `not` before one (its complement), with the outcome its truth
 * takes; `is null` and `is not null` are the null tests. A chain of `not`s is walked, not recursed.
 */
function testForm(expression: Expression, work: WorkLedger): Fact | null {
  let shape = conditionShape(expression);
  let holds = true;
  while (shape.kind === "not") {
    work.charge("indexSteps");
    holds = !holds;
    shape = conditionShape(shape.operand);
  }
  if (shape.kind === "null")
    return { tested: shape.tested, type: null, holds: shape.negated ? !holds : holds };
  if (shape.kind !== "type") return null;
  const type = testedType(shape.node.type, work);
  const outcome = shape.negated ? !holds : holds;
  // `is null` and `is not null` are the null tests
  if (type.kinds.length === 1 && type.kinds[0] === "null")
    return { tested: shape.tested, type: null, holds: outcome };
  return { tested: shape.tested, type, holds: outcome };
}

/**
 * The tests a condition's outcome proves (N1, N9): a test form's own outcome, or its opposite for the false outcome; an
 * `and`'s true outcome what each operand's true outcome proves, an `or`'s false outcome what each operand's false
 * outcome proves (§13.3's W30 and its `or` mirror). Any other compound or negated condition proves nothing.
 */
function facts(condition: Expression, outcome: boolean, into: Fact[], work: WorkLedger): void {
  const pending = [condition];
  while (pending.length > 0) {
    const expression = pending.pop()!;
    work.charge("indexSteps");
    const test = testForm(expression, work);
    if (test !== null) {
      into.push(outcome ? test : opposite(test));
      continue;
    }
    const shape = conditionShape(expression);
    if (shape.kind === (outcome ? "and" : "or")) pending.push(shape.right, shape.left);
  }
}

/** A narrowing definition G (N1): its refined location, its form, where it is defined and where its input is read. */
export interface Narrowing {
  /** The refined location: the stable path's text, followed by `[*]` per element step a collection test names. */
  readonly location: string;
  readonly path: StablePath;
  /** The element steps the location adds to the tested path. */
  readonly elements: number;
  /** The contract key of the location: every index, key and element step is `element`. */
  readonly key: Key;
  /** The index and key variables of the tested path (dependency keys beside the key and its prefixes). */
  readonly variables: readonly Key[];
  /** The collections the tested path reads an element of, by their keys (N2's invalidation lists). */
  readonly collections: readonly Key[];
  /** The guarded region's entry; for an operand region, the test's own node, which every part of it follows. */
  readonly node: FlowNode;
  /**
   * An operand region (N1: the right operands of the `and` or `or` chain whose left the test stands in), by its text;
   * `null` for a branch's region (the entry's).
   */
  readonly region: OperandSpan | null;
  /** The tested operand: G's input is the read there. */
  readonly input: FlowNode;
  readonly form: NarrowingForm;
}

/** An operand region: its file and text span, from its test's end to its chain's end. */
export interface OperandSpan {
  readonly file: number;
  readonly start: number;
  readonly end: number;
}

/**
 * Intervals that nest or lie apart, sorted by where they start (the longer first, and at one interval in the order
 * given), each linked to the nearest one holding it, with skew-binary jumps up that chain (Myers): the innermost one
 * holding a point is a binary search and a logarithmic climb (as the guard index's nests, §3.2).
 */
export class Laminar<T> {
  readonly starts: readonly number[];
  readonly ends: readonly number[];
  readonly items: readonly T[];
  readonly parents: readonly number[];
  readonly #jumps: readonly number[];

  public constructor(
    readonly work: WorkLedger,
    entries: { readonly start: number; readonly end: number; readonly item: T }[],
  ) {
    work.charge("indexSteps", sortCost(entries.length));
    const order = entries.map((_, index) => index);
    order.sort(
      (a, b) => entries[a]!.start - entries[b]!.start || entries[b]!.end - entries[a]!.end || a - b,
    );
    const sorted = order.map((index) => entries[index]!);
    const parents: number[] = [];
    const jumps: number[] = [];
    const depths: number[] = [];
    const open: number[] = [];
    for (const [index, entry] of sorted.entries()) {
      work.charge("indexSteps");
      while (open.length > 0 && sorted[open.at(-1)!]!.end < entry.start) open.pop();
      const parent = open.at(-1) ?? -1;
      parents.push(parent);
      depths.push(parent < 0 ? 0 : depths[parent]! + 1);
      const up = parent < 0 ? -1 : jumps[parent]!;
      const further = up < 0 ? -1 : jumps[up]!;
      jumps.push(
        further >= 0 && depths[parent]! - depths[up]! === depths[up]! - depths[further]!
          ? further
          : parent,
      );
      open.push(index);
    }
    this.starts = sorted.map((entry) => entry.start);
    this.ends = sorted.map((entry) => entry.end);
    this.items = sorted.map((entry) => entry.item);
    this.parents = parents;
    this.#jumps = jumps;
  }

  /** The index of the innermost interval holding `at`, or -1. */
  public innermostIndex(at: number): number {
    let low = 0;
    let high = this.starts.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      this.work.charge("eventSteps");
      if (this.starts[middle]! <= at) low = middle + 1;
      else high = middle;
    }
    // (up the chain the intervals end no earlier: a jump whose interval ends before `at` passes every one below it)
    let index = low - 1;
    while (index >= 0 && this.ends[index]! < at) {
      this.work.charge("eventSteps");
      const jump = this.#jumps[index]!;
      index = jump >= 0 && this.ends[jump]! < at ? this.parents[jump]! : this.parents[index]!;
    }
    return index;
  }

  /** The innermost interval's item holding `at`, or `null`. */
  public innermost(at: number): T | null {
    const index = this.innermostIndex(at);
    return index < 0 ? null : this.items[index]!;
  }
}

/** A mutating method call of a collection (N2's invalidations): where it takes effect and the callable it stands in. */
interface Invalidation {
  readonly node: FlowNode;
  readonly file: number;
  readonly offset: number;
  readonly owner: Callable | null;
  readonly inBlock: boolean;
}

/**
 * One collection key's invalidations: positions outside block code, sorted, and where their calls end by file; the
 * callables holding them, each once; whether a block holds one.
 */
export interface Invalidations {
  readonly positions: readonly number[];
  readonly texts: ReadonlyMap<number, readonly number[]>;
  readonly owners: readonly (Callable | null)[];
  readonly inBlock: boolean;
}

/** The read's own location and its element scopes (N2): each text with the element steps it adds. */
export interface ReadScope {
  readonly location: string;
  readonly path: StablePath;
}

/** Each program's narrowing index, made by the first pass that asks for it. */
const INDEXES = new WeakMap<CoreProgram, NarrowingIndex>();

/**
 * The narrowing index of a program (N1, N2): its definitions per refined location and its invalidation lists, with the
 * statements and N3's shared layer (`StatementTree`). Nothing in it depends on a pass's rejections (A6), so a program
 * makes it once (`of`), charged to its ledger then, and every pass asks the same one.
 */
export class NarrowingIndex {
  /** The program's index, made and charged on its first ask. */
  public static of(program: CoreProgram): NarrowingIndex {
    let index = INDEXES.get(program);
    if (index === undefined) {
      index = new NarrowingIndex(program, new StatementTree(program));
      INDEXES.set(program, index);
    }
    return index;
  }

  /** Per refined location, its branches' narrowing definitions by their regions in the dominator walk. */
  readonly #byLocation = new Map<string, Laminar<Narrowing>>();
  /** Per refined location and file, its operand regions' narrowing definitions by their text spans. */
  readonly #byOperand = new Map<string, Map<number, Laminar<Narrowing>>>();
  /** Per guarded region's entry and refined location, its narrowing definitions in evaluation order (N3's arms). */
  readonly #atEntry = new Map<string, Narrowing[]>();
  /** Per collection key, its mutating method calls (N2). */
  readonly #invalidations = new Map<Key, Invalidations>();
  private constructor(
    readonly program: CoreProgram,
    readonly statements: StatementTree,
  ) {
    const work = program.work;
    const flow = program.flow;
    type Entry = { start: number; end: number; item: Narrowing };
    const lists = new Map<string, Entry[]>();
    const operands = new Map<string, Map<number, Entry[]>>();
    const define = (
      node: FlowNode,
      file: number,
      tested: Expression,
      outcome: { readonly form: NarrowingForm; readonly element: TypeAnnotation | null },
      region: OperandSpan | null = null,
    ): void => {
      if (!program.reached(node)) return;
      const operand = unwrap(tested);
      const path = stablePath(program, file, operand);
      const input = program.exprAt({
        file,
        start: operand.span.start.offset,
        end: operand.span.end.offset,
      });
      if (path === null || input === null) return;
      keptArray(work, path.steps);
      // the keys a G keeps, each charged as it is made (TABLE r4.58)
      const kept = (key: Key): Key => {
        keepText(work, key.length);
        return key;
      };
      const variables = path.steps.flatMap((step) =>
        step.kind === "variable" ? [kept(keyOf(step.place, []))] : [],
      );
      const base = path.steps.flatMap((step, index) =>
        readsElement(step) ? [kept(pathKey(path, index))] : [],
      );
      // the tested path and, for a positive collection test, one more element step per element type it names: each
      // element step's collection, the tested path's key and those below it, is one of its G's collections too (N2)
      let { form, element } = outcome;
      let collections = base;
      let key = kept(pathKey(path));
      for (let elements = 0; ; elements += 1) {
        work.charge("indexSteps");
        const location = locationOf(path, elements, work);
        const g: Narrowing = {
          location,
          path,
          elements,
          key,
          variables,
          collections,
          node,
          region,
          input,
          form,
        };
        if (region === null) {
          const list = lists.get(location);
          const entry = { start: program.position(node), end: program.positionEnd(node), item: g };
          if (list === undefined) lists.set(location, [entry]);
          else list.push(entry);
          const entryKey = keptParts(work, node.id, location);
          const at = this.#atEntry.get(entryKey);
          if (at === undefined) this.#atEntry.set(entryKey, [g]);
          else at.push(g);
        } else {
          let byFile = operands.get(location);
          if (byFile === undefined) operands.set(location, (byFile = new Map()));
          const list = byFile.get(file);
          const entry = { start: region.start, end: region.end, item: g };
          if (list === undefined) byFile.set(file, [entry]);
          else list.push(entry);
        }
        if (element === null) break;
        const inner = testedType(element, work);
        form = { kind: "is", kinds: inner.kinds };
        element = inner.element;
        collections = keptSteps(work, collections, [key]);
        key = kept(keyBelow(key, ["element"]));
      }
    };
    const proven: Fact[] = [];
    // `if` conditions (the then arm, the else arm or the way past) and `while` conditions (the body only)
    for (const use of flow.conditionUses)
      for (const [index, branch] of use.branches.entries()) {
        if (index > 1) break;
        proven.length = 0;
        facts(use.operand, index === 0, proven, work);
        for (const fact of proven) define(branch, use.file, fact.tested, formOf(fact));
      }
    // `switch` cases: `case null`, a literal case by its value, `default` and later cases after `case null`
    for (const use of flow.switchUses) {
      const statement = statements.switchAt(use.file, use.span.start.offset, use.span.end.offset);
      if (statement === undefined) continue;
      let afterNull = false;
      for (const [index, branch] of use.branches.entries()) {
        work.charge("indexSteps");
        const switchCase = statement.cases[index];
        const form =
          switchCase === undefined ? null : caseForm(switchCase.values, switchCase.typeTest);
        const after = afterNull ? NON_NULL : null;
        if (form !== null) define(branch, use.file, use.operand, { form, element: null });
        else if (after !== null)
          define(branch, use.file, use.operand, { form: after, element: null });
        if (switchCase !== undefined && form?.kind === "null") afterNull = true;
      }
    }
    this.#operandRegions(define);
    for (const [location, list] of lists) this.#byLocation.set(location, new Laminar(work, list));
    for (const [location, byFile] of operands) {
      const nests = new Map<number, Laminar<Narrowing>>();
      for (const [file, list] of byFile) nests.set(file, new Laminar(work, list));
      this.#byOperand.set(location, nests);
    }
    this.#invalidate();
  }

  /**
   * N1's operand regions: a test form in an `and` chain's left defines the chain's right operands after it, from its
   * end to the end of the highest `and` whose left holds it through `and`s alone; in an `or` chain's left, with its
   * complement, likewise. One region per test, laminar per location (two regions of one location nest or lie apart). A
   * walk of each outermost logical tree with an explicit stack; a logical below another expression is a tree of its own.
   */
  #operandRegions(
    define: (
      node: FlowNode,
      file: number,
      tested: Expression,
      outcome: { readonly form: NarrowingForm; readonly element: TypeAnnotation | null },
      region: OperandSpan,
    ) => void,
  ): void {
    const program = this.program;
    const work = program.work;
    const logicals = [...program.flow.logicals].sort(
      (a, b) =>
        a.file - b.file ||
        a.expression.span.start.offset - b.expression.span.start.offset ||
        b.expression.span.end.offset - a.expression.span.end.offset,
    );
    work.charge("indexSteps", sortCost(logicals.length));
    let outer: (typeof logicals)[number] | null = null;
    type Visit = {
      readonly expression: Expression;
      readonly and: Expression | null;
      readonly or: Expression | null;
    };
    for (const logical of logicals) {
      work.charge("indexSteps");
      if (
        outer !== null &&
        outer.file === logical.file &&
        logical.expression.span.end.offset <= outer.expression.span.end.offset
      )
        continue;
      outer = logical;
      const file = logical.file;
      const pending: Visit[] = [{ expression: logical.expression, and: null, or: null }];
      while (pending.length > 0) {
        const { expression, and, or } = pending.pop()!;
        work.charge("indexSteps");
        const test = testForm(expression, work);
        if (test !== null) {
          const node = program.exprAt({
            file,
            start: expression.span.start.offset,
            end: expression.span.end.offset,
          });
          for (const [top, fact] of [
            [and, test],
            [or, opposite(test)],
          ] as const)
            if (node !== null && top !== null)
              define(node, file, fact.tested, formOf(fact), {
                file,
                start: expression.span.end.offset,
                end: top.span.end.offset,
              });
          continue;
        }
        const shape = conditionShape(expression);
        if (shape.kind === "and" || shape.kind === "or") {
          const self = unwrap(expression);
          pending.push(
            shape.kind === "and"
              ? { expression: shape.right, and, or: null }
              : { expression: shape.right, and: null, or },
          );
          pending.push(
            shape.kind === "and"
              ? { expression: shape.left, and: and ?? self, or: null }
              : { expression: shape.left, and: null, or: or ?? self },
          );
          continue;
        }
        for (const child of expressionChildren(unwrap(expression)))
          pending.push({ expression: child, and: null, or: null });
      }
    }
  }

  /** N2: the mutating method calls of collections, one sorted list per collection key. */
  #invalidate(): void {
    const program = this.program;
    const work = program.work;
    const found = new Map<Key, Invalidation[]>();
    const add = (
      receiver: PlaceId,
      path: readonly string[] | null,
      at: FlowNode | null,
      site: { readonly file: number; readonly end: number },
    ): void => {
      if (at === null || !program.live(at)) return;
      const target = program.targetRoot(program.occurrenceOf.get(receiver) ?? receiver);
      const key = keyOf(target.root, path ?? target.path);
      const list = found.get(key);
      const entry: Invalidation = {
        node: at,
        file: site.file,
        offset: site.end,
        owner: program.flow.ownerOf(at.region),
        inBlock: program.inBlockCode(at),
      };
      if (list === undefined) {
        keepText(work, key.length);
        found.set(key, [entry]);
      } else list.push(entry);
    };
    for (const constraint of program.constraints) {
      work.charge("indexSteps");
      // a removal, a clear, and the order-changing `sort`, `shuffle`, `reverse` (F5–F8)
      if (
        constraint.kind === "operation" &&
        constraint.contract.family === "method" &&
        typeof constraint.receiver === "number" &&
        mutates(constraint.contract.name)
      )
        add(constraint.receiver, null, program.effectNode(constraint.site), constraint.site);
      // an add: a store into the collection's elements at its call
      if (
        constraint.kind === "store" &&
        ["element", "elements", "entry"].includes(constraint.how)
      ) {
        const projection = program.projOf.get(constraint.into);
        if (projection === undefined || projection.step === "index") continue;
        const target = program.targetRoot(constraint.into);
        // (an add takes effect at its call, as its definition does)
        add(
          constraint.into,
          target.path.slice(0, -1),
          projection.node?.expression?.kind === "callExpression"
            ? projection.node
            : program.effectNode(constraint.site),
          constraint.site,
        );
      }
    }
    for (const [collection, list] of found) {
      const positions: number[] = [];
      const texts = new Map<number, number[]>();
      const owners: (Callable | null)[] = [];
      const seen = new Set<Callable | null>();
      let inBlock = false;
      for (const entry of list) {
        work.charge("indexSteps");
        if (!seen.has(entry.owner)) {
          seen.add(entry.owner);
          owners.push(entry.owner);
        }
        if (entry.inBlock) {
          inBlock = true;
          continue;
        }
        positions.push(program.position(entry.node));
        const offsets = texts.get(entry.file);
        if (offsets === undefined) texts.set(entry.file, [entry.offset]);
        else offsets.push(entry.offset);
      }
      work.charge("indexSteps", 2 * sortCost(positions.length));
      positions.sort((a, b) => a - b);
      for (const offsets of texts.values()) offsets.sort((a, b) => a - b);
      this.#invalidations.set(collection, { positions, texts, owners, inBlock });
    }
  }

  /** A collection key's invalidations (N2), or `undefined` without one. */
  public invalidations(key: Key): Invalidations | undefined {
    return this.#invalidations.get(key);
  }

  /** The nearest narrowing definition of `location` whose region holds `node` (N2): a binary search and a climb. */
  public nearest(location: string, node: FlowNode): Narrowing | null {
    const program = this.program;
    program.work.charge("eventSteps");
    if (!program.reached(node)) return null;
    // (an operand region lies inside an expression, so inside every branch region that holds it: it is the nearer)
    const operand =
      node.span === null
        ? null
        : (this.#byOperand.get(location)?.get(node.file)?.innermost(node.span.start.offset) ??
          null);
    return operand ?? this.#byLocation.get(location)?.innermost(program.position(node)) ?? null;
  }

  /** The branches' narrowing definitions of a refined location (the blocking tests of N3). */
  public definitionsOf(location: string): readonly Narrowing[] {
    return this.#byLocation.get(location)?.items ?? [];
  }

  /** The narrowing definitions of a refined location at a guarded region's entry, in evaluation order. */
  public atEntry(node: FlowNode, location: string): readonly Narrowing[] {
    this.program.work.charge("eventSteps");
    return this.#atEntry.get(joinParts(node.id, location)) ?? [];
  }

  /**
   * The locations a read at `node` asks (N2): its own path's text, and for each split of its trailing element steps
   * the element scope of the path before them (`rows[i][j]` asks `rows[i][*]` and `rows[*][*]`): one per depth.
   */
  public scopes(node: FlowNode): ReadScope[] {
    const expression = node.expression;
    if (expression === undefined) return [];
    const path = stablePath(this.program, node.file, expression, true);
    if (path === null) return [];
    const scopes: ReadScope[] = [];
    if (path.steps.every((step) => step.kind !== "element"))
      scopes.push({ location: locationOf(path), path });
    for (let length = path.steps.length - 1; length >= 0; length -= 1) {
      this.program.work.charge("eventSteps");
      if (!readsElement(path.steps[length]!)) break;
      scopes.push({ location: locationOf(path, path.steps.length - length, null, length), path });
    }
    return scopes;
  }

  /** The nearest narrowing definition of any of a read's locations (the deepest region wins), or `null`. */
  public nearestAt(node: FlowNode): Narrowing | null {
    let best: Narrowing | null = null;
    for (const scope of this.scopes(node)) {
      const g = this.nearest(scope.location, node);
      if (g !== null && (best === null || nearer(this.program, g, best))) best = g;
    }
    return best;
  }
}

/** Whether `a` lies inside `b`'s region: an operand region inside a branch's, or the deeper of two of a kind. */
function nearer(program: CoreProgram, a: Narrowing, b: Narrowing): boolean {
  if ((a.region === null) !== (b.region === null)) return a.region !== null;
  return a.region !== null && b.region !== null
    ? a.region.start > b.region.start
    : program.position(a.node) > program.position(b.node);
}

/** The labels of a path's first `length` steps followed by `elements` element steps. */
function labelsOf(path: StablePath, elements: number, length = path.steps.length): string[] {
  const labels: string[] = [];
  for (let index = 0; index < length; index += 1) labels.push(stepLabel(path.steps[index]!));
  for (let index = 0; index < elements; index += 1) labels.push("[*]");
  return labels;
}

/**
 * The refined location of a path's first `length` steps followed by `elements` element steps, its text charged where
 * a structure keeps it (`work`), made plain where a step only looks it up.
 */
export function locationOf(
  path: StablePath,
  elements = 0,
  work: WorkLedger | null = null,
  length = path.steps.length,
): string {
  const labels = labelsOf(path, elements, length);
  return work === null ? joinParts(path.root, labels) : keptParts(work, path.root, labels);
}

/** Whether a method changes the collection it is called on in place (`ListMethod.changes`, `DictMethod.changes`). */
function mutates(name: string): boolean {
  return (listMethod(name)?.changes ?? dictMethod(name)?.changes) !== undefined;
}

/** A `switch` case's form (N1): `case null`, or one literal by its value; other cases (several values, a range) none. */
function caseForm(
  values: readonly Expression[],
  typeTest: { readonly negated: boolean } | null,
): NarrowingForm | null {
  if (typeTest !== null || values.length !== 1) return null;
  const key = caseValueKey(values[0]!);
  if (key === undefined) return null;
  if (key === "null") return ONLY_NULL;
  if (key.startsWith("string:")) return { kind: "is", kinds: ["string"] };
  if (!key.startsWith("number:")) return null;
  return Number.isInteger(Number(key.slice("number:".length)))
    ? { kind: "is", kinds: ["integer"] }
    : { kind: "is", kinds: ["number"], fractional: true };
}
