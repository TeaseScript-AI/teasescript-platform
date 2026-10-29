import type { Expression, TypeAnnotation } from "../../ast.js";
import { expressionChildren } from "../../expression-children.js";
import { dictMethod } from "../../dict-operations.js";
import { listMethod } from "../../list-methods.js";
import { caseLiteral } from "../../switch-cases.js";
import type { ValueKind } from "../../value-kinds.js";
import type { PlaceId } from "../graph.js";
import { conditionShape } from "../narrowing-shapes.js";
import { joinParts, keepText, keptArray, keptParts, type WorkLedger } from "./budget.js";
import { keyBelow, keyOf, type Key } from "./definitions.js";
import type { Callable, FlowNode } from "./flow-graph.js";
import { mergeItems, REASON, type Item, type ItemScope, type ItemTag } from "./items.js";
import { selectsElement } from "./method-categories.js";
import { propertyStep, siteKey, type CoreProgram } from "./program.js";
import {
  copied,
  each,
  every,
  flatMapped,
  mapped,
  passing,
  some,
  sorted,
  steps,
} from "./narrowing-iteration.js";
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

/**
 * A step's text in a refined location: `.n`, `[number:0]`, `[string:key]`, `[@12]` (an index variable's place), `[*]`.
 * A key's `\` and `]` are escaped, so its label ends at its first bare `]` and no key text spells another path (#1244).
 */
function stepLabel(step: PathStep, work: WorkLedger): string {
  work.charge("eventSteps");
  switch (step.kind) {
    case "property":
      return `.${step.name}`;
    case "fixed":
      return `[${step.text.replace(/[\\\]]/g, "\\$&")}]`;
    case "variable":
      return `[@${step.place}]`;
    case "element":
      return "[*]";
  }
}

/** Whether a step reads an element of a collection: an index, a key, or a selection (`first`, `last`, `random`). */
function readsElement(step: PathStep, work: WorkLedger): boolean {
  work.charge("eventSteps");
  return step.kind !== "property" || selectsElement(step.name);
}

/** An expression without the parentheses around it, each one walked charged (they nest as deep as written). */
function peel(expression: Expression, work: WorkLedger): Expression {
  work.charge("eventSteps");
  let current = expression;
  for (const _ of steps(work, "eventSteps", () => current.kind === "parenthesizedExpression"))
    if (current.kind === "parenthesizedExpression") current = current.expression;
  return current;
}

/**
 * A condition's shape (`conditionShape`), the parentheses it walks charged: around the condition, and around a
 * comparison's operands, which it walks to find the `null` literal.
 */
function shapeOf(expression: Expression, work: WorkLedger): ReturnType<typeof conditionShape> {
  work.charge("eventSteps");
  const node = peel(expression, work);
  if (node.kind === "binaryExpression" && (node.operator === "==" || node.operator === "!=")) {
    peel(node.left, work);
    peel(node.right, work);
  }
  return conditionShape(node);
}

/**
 * A literal index's or case's kind and key (`caseLiteral`), the parentheses and sign it walks charged, and the literal's
 * text it reads and makes charged as a kept text is (TABLE r4.58).
 */
function literalOf(expression: Expression, work: WorkLedger): ReturnType<typeof caseLiteral> {
  work.charge("eventSteps");
  const node = peel(expression, work);
  if (node.kind === "unaryExpression" && (node.operator === "-" || node.operator === "+"))
    peel(node.operand, work);
  // (a string's parts, read up to its first interpolation)
  if (node.kind === "stringLiteral") work.charge("indexSteps", node.parts.length);
  const literal = caseLiteral(node);
  if (literal !== undefined) keepText(work, literal.key.length);
  return literal;
}

/**
 * An expression's operands (`expressionChildren`), the parts it walks and gives none for charged as well: a string's
 * texts, a tag query's tags and operators.
 */
function childrenOf(expression: Expression, work: WorkLedger): readonly Expression[] {
  work.charge("indexSteps");
  if (expression.kind === "stringLiteral") work.charge("indexSteps", expression.parts.length);
  else if (expression.kind === "tagQueryExpression")
    work.charge("indexSteps", expression.steps.length);
  return expressionChildren(expression);
}

/** The contract key a path's read asks (§1: every index, key and selection is `element`), a step charged per step. */
export function pathKey(path: StablePath, work: WorkLedger, length = path.steps.length): Key {
  work.charge("eventSteps");
  let index = 0;
  const made: string[] = [];
  for (const _ of steps(work, "eventSteps", () => index < length)) {
    const step = path.steps[index]!;
    made.push(
      step.kind === "property" && !readsElement(step, work) ? propertyStep(step.name) : "element",
    );
    index += 1;
  }
  return keyOf(path.root, made);
}

/**
 * The stable path an expression reads (N1): a binding followed by properties, fixed indexes or keys, and indexes or
 * keys held in plain variables; with `trailing`, element reads (a computed index, `.random`) too where every step after
 * them reads an element (`rows[i + 1][0]`), which only an element scope finds (#1245). `null` for anything else: a
 * call, a literal, a path through a computed index, a speaker. An assignment's target names its `root`, which it does
 * not read.
 */
export function stablePath(
  program: CoreProgram,
  file: number,
  expression: Expression,
  trailing = false,
  root: PlaceId | null = null,
): StablePath | null {
  program.work.charge("eventSteps");
  // (outermost first, each put in front: whether every step so far reads an element)
  const outermost: PathStep[] = [];
  let trailingOnly = true;
  const work = program.work;
  let current = peel(expression, work);
  for (const _ of steps(work, "eventSteps", () => current.kind !== "identifier")) {
    if (current.kind === "propertyAccessExpression") {
      const name = current.property.name;
      if (name === "random") {
        if (!trailing || !trailingOnly) return null;
        outermost.push({ kind: "element" });
      } else {
        outermost.push({ kind: "property", name });
        if (!selectsElement(name)) trailingOnly = false;
      }
      current = peel(current.object, work);
      continue;
    }
    if (current.kind !== "indexExpression") return null;
    const index = peel(current.index, work);
    const fixed = literalOf(index, work)?.key;
    const variable = index.kind === "identifier" ? bindingOf(program, file, index) : null;
    if (fixed !== undefined && (fixed.startsWith("number:") || fixed.startsWith("string:")))
      outermost.push({ kind: "fixed", text: fixed });
    else if (variable !== null) outermost.push({ kind: "variable", place: variable });
    else if (trailing && trailingOnly) outermost.push({ kind: "element" });
    else return null;
    current = peel(current.object, work);
  }
  const binding = root ?? bindingOf(program, file, current);
  if (binding === null) return null;
  // (innermost first)
  let index = outermost.length;
  const ordered: PathStep[] = [];
  for (const _ of steps(work, "eventSteps", () => index > 0)) {
    index -= 1;
    ordered.push(outermost[index]!);
  }
  return { root: binding, steps: ordered };
}

/** The binding an identifier reads: a `let`, `global`, loop variable or parameter. */
function bindingOf(program: CoreProgram, file: number, identifier: Expression): PlaceId | null {
  program.work.charge("eventSteps");
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

/** Whether an item of kind `tag` lies wholly within `kinds` (an integer is a number), each kind compared charged. */
function within(tag: ItemTag, kinds: readonly ValueKind[], work: WorkLedger): boolean {
  work.charge("mergeItems");
  return some(
    work,
    "mergeItems",
    kinds,
    (kind) => kind === tag || (tag === "integer" && kind === "number"),
  );
}

/** The kind an item of kind `tag` keeps under a positive test of `kind`, or `null` when they are disjoint. */
function overlap(
  tag: ItemTag,
  kind: ValueKind,
  fractional: boolean,
  work: WorkLedger,
): ItemTag | null {
  work.charge("mergeItems");
  if (tag === "unknown") return kind;
  if (fractional) return tag === "number" ? "number" : null;
  if (tag === kind) return tag;
  // a whole number passes `is integer`; an integer is a number
  if (tag === "number" && kind === "integer") return "integer";
  if (tag === "integer" && kind === "number") return "integer";
  return null;
}

/**
 * An item a test proves of a kind: an unknown that a stop left (`budget`) is known by the test itself, so the stop's
 * reason and word go; any other keeps its own (host data its external origin), TABLE r4.183.
 */
function proved(item: Item, tag: ItemTag): Item {
  return item.tag === "unknown" && (item.reasons & REASON.budget) !== 0
    ? { ...item, tag, reasons: item.reasons & ~REASON.budget, context: null }
    : { ...item, tag };
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
  scope.work.charge("mergeItems");
  const work = scope.work;
  const kept: Item[] = [];
  for (const item of each(work, "mergeItems", items)) {
    if (item.tag === "empty") {
      kept.push(item);
      continue;
    }
    switch (form.kind) {
      case "non-null":
        if (item.tag !== "null") kept.push(item);
        break;
      case "null":
        if (item.tag === "null" || item.tag === "unknown") kept.push(proved(item, "null"));
        break;
      case "is":
        for (const kind of each(work, "mergeItems", form.kinds)) {
          const tag = overlap(item.tag, kind, form.fractional === true, work);
          if (tag !== null) kept.push(tag === item.tag ? item : proved(item, tag));
        }
        break;
      case "is-not":
        if (item.tag === "unknown" || !within(item.tag, form.kinds, work)) kept.push(item);
        break;
    }
  }
  const merged = mergeItems(kept, scope);
  if (form.kind === "is-not") return merged;
  const left = passing(work, "mergeItems", merged, (item) => item.tag !== "empty");
  if (left.length !== 1 || left[0]!.tag === "unknown" || left[0]!.cert === "def") return merged;
  return mapped(work, "mergeItems", merged, (item) =>
    item === left[0] ? { ...item, cert: "def" } : item,
  );
}

/**
 * Whether a narrowing of this form removes items of kind `tag` (a G of the needed form for N3's offending kind): a
 * comparison per kind of a type test, charged.
 */
export function removes(form: NarrowingForm, tag: ItemTag, work: WorkLedger): boolean {
  work.charge("eventSteps");
  switch (form.kind) {
    case "non-null":
      return tag === "null";
    case "null":
      return tag !== "null";
    case "is":
      return every(
        work,
        "eventSteps",
        form.kinds,
        (kind) => overlap(tag, kind, form.fractional === true, work) === null,
      );
    case "is-not":
      return within(tag, form.kinds, work);
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
  work.charge("indexSteps");
  // (each kind once, however often the type names it: a filter's visits are bounded by the value kinds)
  const kinds = new Set<ValueKind>();
  const constrained = new Set<ValueKind>();
  const elements: TypeAnnotation[] = [];
  let others = 0;
  const pending = [annotation];
  for (const _ of steps(work, "indexSteps", () => pending.length > 0)) {
    const type = pending.pop()!;
    switch (type.kind) {
      case "namedType":
        kinds.add(type.name);
        if (type.name !== "null") others += 1;
        break;
      case "listType":
      case "setType":
      case "dictType": {
        const kind = type.kind === "listType" ? "list" : type.kind === "setType" ? "set" : "dict";
        kinds.add(kind);
        constrained.add(kind);
        elements.push(type.element);
        break;
      }
      case "optionalType":
        kinds.add("null");
        pending.push(type.value);
        break;
      case "unionType":
        for (const member of each(work, "indexSteps", type.members)) pending.push(member);
        break;
    }
  }
  return {
    kinds: copied(work, "indexSteps", kinds),
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
  /** Where the test form ends (its `not`s included): the events of the condition after it are G's (N2). */
  readonly end: number;
  readonly type: TestedType | null;
  readonly holds: boolean;
}

/** The complement arm, an `or`'s right operand, the way past a leave: the opposite outcome. */
function opposite(fact: Fact, work: WorkLedger): Fact {
  work.charge("indexSteps");
  return { ...fact, holds: !fact.holds };
}

/**
 * What a fact's outcome leaves (N1): `null` alone or every item but `null` for a null test; for a type test that holds,
 * each item's overlap with the type, and an element step's test per element type the type names; for one that fails,
 * only the items wholly within the type removed (never a collection kind the type names with an element type).
 */
function formOf(
  fact: Fact,
  work: WorkLedger,
): { readonly form: NarrowingForm; readonly element: TypeAnnotation | null } {
  work.charge("indexSteps");
  const type = fact.type;
  if (type === null) return { form: fact.holds ? ONLY_NULL : NON_NULL, element: null };
  return fact.holds
    ? { form: { kind: "is", kinds: type.kinds }, element: type.element }
    : {
        form: {
          kind: "is-not",
          kinds: passing(work, "indexSteps", type.kinds, (kind) => !type.constrained.has(kind)),
        },
        element: null,
      };
}

/**
 * A test form (N1): a null test or a type test, or `not` before one (its complement), with the outcome its truth
 * takes; `is null` and `is not null` are the null tests. A chain of `not`s is walked, not recursed.
 */
function testForm(expression: Expression, work: WorkLedger): Fact | null {
  work.charge("indexSteps");
  const end = expression.span.end.offset;
  let shape = shapeOf(expression, work);
  let holds = true;
  for (const _ of steps(work, "indexSteps", () => shape.kind === "not"))
    if (shape.kind === "not") {
      holds = !holds;
      shape = shapeOf(shape.operand, work);
    }
  if (shape.kind === "null")
    return { tested: shape.tested, end, type: null, holds: shape.negated ? !holds : holds };
  if (shape.kind !== "type") return null;
  const type = testedType(shape.node.type, work);
  const outcome = shape.negated ? !holds : holds;
  // `is null` and `is not null` are the null tests
  if (type.kinds.length === 1 && type.kinds[0] === "null")
    return { tested: shape.tested, end, type: null, holds: outcome };
  return { tested: shape.tested, end, type, holds: outcome };
}

/**
 * The tests a condition's outcome proves (N1, N9): a test form's own outcome, or its opposite for the false outcome; an
 * `and`'s true outcome what each operand's true outcome proves, an `or`'s false outcome what each operand's false
 * outcome proves (§13.3's W30 and its `or` mirror). Any other compound or negated condition proves nothing.
 */
function facts(condition: Expression, outcome: boolean, into: Fact[], work: WorkLedger): void {
  work.charge("indexSteps");
  const pending = [condition];
  for (const _ of steps(work, "indexSteps", () => pending.length > 0)) {
    const expression = pending.pop()!;
    const test = testForm(expression, work);
    if (test !== null) {
      into.push(outcome ? test : opposite(test, work));
      continue;
    }
    const shape = shapeOf(expression, work);
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
  /**
   * A branch's G: the rest of its condition after its test, whose events come between the test and the entry (an
   * `and`'s or `or`'s later operands, N1, N2); `null` for an operand region's.
   */
  readonly window: OperandSpan | null;
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
    work.charge("indexSteps");
    const order = mapped(work, "indexSteps", entries, (_, index) => index);
    sorted(
      work,
      "indexSteps",
      order,
      (a, b) => entries[a]!.start - entries[b]!.start || entries[b]!.end - entries[a]!.end || a - b,
    );
    const ordered = mapped(work, "indexSteps", order, (index) => entries[index]!);
    const parents: number[] = [];
    const jumps: number[] = [];
    const depths: number[] = [];
    const open: number[] = [];
    for (const [index, entry] of each(work, "indexSteps", ordered.entries())) {
      for (const _ of steps(
        work,
        "indexSteps",
        () => open.length > 0 && ordered[open.at(-1)!]!.end < entry.start,
      ))
        open.pop();
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
    this.starts = mapped(work, "indexSteps", ordered, (entry) => entry.start);
    this.ends = mapped(work, "indexSteps", ordered, (entry) => entry.end);
    this.items = mapped(work, "indexSteps", ordered, (entry) => entry.item);
    this.parents = parents;
    this.#jumps = jumps;
  }

  /** The index of the innermost interval holding `at`, or -1. */
  public innermostIndex(at: number): number {
    this.work.charge("eventSteps");
    let low = 0;
    let high = this.starts.length;
    for (const _ of steps(this.work, "eventSteps", () => low < high)) {
      const middle = (low + high) >> 1;
      if (this.starts[middle]! <= at) low = middle + 1;
      else high = middle;
    }
    // (up the chain the intervals end no earlier: a jump whose interval ends before `at` passes every one below it)
    let index = low - 1;
    for (const _ of steps(this.work, "eventSteps", () => index >= 0 && this.ends[index]! < at)) {
      const jump = this.#jumps[index]!;
      index = jump >= 0 && this.ends[jump]! < at ? this.parents[jump]! : this.parents[index]!;
    }
    return index;
  }

  /** The innermost interval's item holding `at`, or `null`. */
  public innermost(at: number): T | null {
    this.work.charge("eventSteps");
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

/**
 * A node of the trie of tested paths: a path's steps from its root, each by its label; the refined locations of the
 * path ending here followed by k element steps, by k (k = 0: the path's own).
 */
interface PathNode {
  readonly children: Map<string, PathNode>;
  readonly locations: Map<number, string>;
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
    program.work.charge("indexSteps");
    let index = INDEXES.get(program);
    if (index === undefined) {
      index = new NarrowingIndex(program, new StatementTree(program));
      INDEXES.set(program, index);
    }
    return index;
  }

  /** The tested paths, per root, as a trie: a read finds its own location and its element scopes in one walk. */
  readonly #tested = new Map<PlaceId, PathNode>();
  /** Per refined location, its branches' narrowing definitions by their regions in the dominator walk. */
  readonly #byLocation = new Map<string, Laminar<Narrowing>>();
  /** Per refined location and file, its operand regions' narrowing definitions by their text spans. */
  readonly #byOperand = new Map<string, Map<number, Laminar<Narrowing>>>();
  /** Per guarded region's entry and refined location, its narrowing definitions in evaluation order (N3's arms). */
  readonly #atEntry = new Map<string, Narrowing[]>();
  /** Per collection key, its mutating method calls (N2). */
  readonly #invalidations = new Map<Key, Invalidations>();
  /** Every narrowing definition, in the order they are made (the solver's component test finds one by its key). */
  readonly all: Narrowing[] = [];
  private constructor(
    readonly program: CoreProgram,
    readonly statements: StatementTree,
  ) {
    program.work.charge("indexSteps");
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
      window: OperandSpan | null = null,
    ): void => {
      // (one unit per definition asked, `#operandRegions` among the askers)
      work.charge("indexSteps");
      if (!program.reached(node)) return;
      const operand = peel(tested, work);
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
        work.charge("indexSteps");
        keepText(work, key.length);
        return key;
      };
      const variables = flatMapped(work, "indexSteps", path.steps, (step) =>
        step.kind === "variable" ? [kept(keyOf(step.place, []))] : [],
      );
      const base = flatMapped(work, "indexSteps", path.steps, (step, index) =>
        readsElement(step, work) ? [kept(pathKey(path, work, index))] : [],
      );
      // the tested path and, for a positive collection test, one more element step per element type it names: each
      // element step's collection, the tested path's key and those below it, is one of its G's collections too (N2)
      let { form, element } = outcome;
      let collections = base;
      let key = kept(pathKey(path, work));
      // the tested path in the trie of tested paths, its locations by the element steps they add
      let at: PathNode | undefined = this.#tested.get(path.root);
      if (at === undefined) {
        at = { children: new Map(), locations: new Map() };
        this.#tested.set(path.root, at);
      }
      for (const step of each(work, "indexSteps", path.steps)) {
        const label = stepLabel(step, work);
        let child: PathNode | undefined = at.children.get(label);
        if (child === undefined) {
          child = { children: new Map(), locations: new Map() };
          at.children.set(label, child);
        }
        at = child;
      }
      let elements = -1;
      for (const _ of steps(work, "indexSteps", () => true)) {
        elements += 1;
        const location = locationOf(path, work, elements, true);
        at.locations.set(elements, location);
        const g: Narrowing = {
          location,
          path,
          elements,
          key,
          variables,
          collections,
          node,
          region,
          window,
          input,
          form,
        };
        this.all.push(g);
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
        const below = copied(work, "indexSteps", collections);
        below.push(key);
        collections = below;
        key = kept(keyBelow(key, ["element"]));
      }
    };
    const proven: Fact[] = [];
    // `if` conditions (the then arm, the else arm or the way past) and `while` conditions (the body only)
    for (const use of each(work, "indexSteps", flow.conditionUses))
      for (const [index, branch] of each(work, "indexSteps", use.branches.entries())) {
        if (index > 1) break;
        proven.length = 0;
        facts(use.operand, index === 0, proven, work);
        for (const fact of each(work, "indexSteps", proven))
          define(branch, use.file, fact.tested, formOf(fact, work), null, {
            file: use.file,
            start: fact.end,
            end: use.span.end.offset,
          });
      }
    // `switch` cases: `case null`, a literal case by its value, `default` and later cases after `case null`
    for (const use of each(work, "indexSteps", flow.switchUses)) {
      const statement = statements.switchAt(use.file, use.span.start.offset, use.span.end.offset);
      if (statement === undefined) continue;
      let afterNull = false;
      for (const [index, branch] of each(work, "indexSteps", use.branches.entries())) {
        const switchCase = statement.cases[index];
        const form =
          switchCase === undefined ? null : caseForm(switchCase.values, switchCase.typeTest, work);
        const after = afterNull ? NON_NULL : null;
        if (form !== null) define(branch, use.file, use.operand, { form, element: null });
        else if (after !== null)
          define(branch, use.file, use.operand, { form: after, element: null });
        if (switchCase !== undefined && form?.kind === "null") afterNull = true;
      }
    }
    this.#operandRegions(define);
    for (const [location, list] of each(work, "indexSteps", lists))
      this.#byLocation.set(location, new Laminar(work, list));
    for (const [location, byFile] of each(work, "indexSteps", operands)) {
      const nests = new Map<number, Laminar<Narrowing>>();
      for (const [file, list] of each(work, "indexSteps", byFile))
        nests.set(file, new Laminar(work, list));
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
    this.program.work.charge("indexSteps");
    const program = this.program;
    const work = program.work;
    const logicals = sorted(
      work,
      "indexSteps",
      copied(work, "indexSteps", program.flow.logicals),
      (a, b) =>
        a.file - b.file ||
        a.expression.span.start.offset - b.expression.span.start.offset ||
        b.expression.span.end.offset - a.expression.span.end.offset,
    );
    let outer: (typeof logicals)[number] | null = null;
    type Visit = {
      readonly expression: Expression;
      readonly and: Expression | null;
      readonly or: Expression | null;
    };
    for (const logical of each(work, "indexSteps", logicals)) {
      if (
        outer !== null &&
        outer.file === logical.file &&
        logical.expression.span.end.offset <= outer.expression.span.end.offset
      )
        continue;
      outer = logical;
      const file = logical.file;
      const pending: Visit[] = [{ expression: logical.expression, and: null, or: null }];
      for (const _ of steps(work, "indexSteps", () => pending.length > 0)) {
        const { expression, and, or } = pending.pop()!;
        const test = testForm(expression, work);
        if (test !== null) {
          const node = program.exprAt({
            file,
            start: expression.span.start.offset,
            end: expression.span.end.offset,
          });
          for (const [top, fact] of each(work, "indexSteps", [
            [and, test],
            [or, opposite(test, work)],
          ] as const))
            if (node !== null && top !== null)
              define(node, file, fact.tested, formOf(fact, work), {
                file,
                start: expression.span.end.offset,
                end: top.span.end.offset,
              });
          continue;
        }
        const shape = shapeOf(expression, work);
        if (shape.kind === "and" || shape.kind === "or") {
          const self = peel(expression, work);
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
        for (const child of each(work, "indexSteps", childrenOf(peel(expression, work), work)))
          pending.push({ expression: child, and: null, or: null });
      }
    }
  }

  /** N2: the mutating method calls of collections, one sorted list per collection key. */
  #invalidate(): void {
    this.program.work.charge("indexSteps");
    const program = this.program;
    const work = program.work;
    const found = new Map<Key, Invalidation[]>();
    const add = (
      receiver: PlaceId,
      path: readonly string[] | null,
      at: FlowNode | null,
      site: { readonly file: number; readonly end: number },
    ): void => {
      work.charge("indexSteps");
      if (at === null || !program.live(at)) return;
      const target = program.targetRoot(program.occurrenceOf.get(receiver) ?? receiver);
      work.charge("indexSteps", target.path.length);
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
    for (const constraint of each(work, "indexSteps", program.constraints)) {
      // a removal, a clear, and the order-changing `sort`, `shuffle`, `reverse` (F5–F8)
      if (
        constraint.kind === "operation" &&
        constraint.contract.family === "method" &&
        typeof constraint.receiver === "number" &&
        mutates(constraint.contract.name, work)
      )
        add(constraint.receiver, null, program.effectNode(constraint.site), constraint.site);
      // an add: a store into the collection's elements at its call
      if (constraint.kind === "store" && ADDS.has(constraint.how)) {
        const projection = program.projOf.get(constraint.into);
        if (projection === undefined || projection.step === "index") continue;
        // (the collection's path: the element's without its last step)
        const collection = copied(work, "indexSteps", program.targetRoot(constraint.into).path);
        collection.pop();
        // (an add takes effect at its call, as its definition does)
        add(
          constraint.into,
          collection,
          projection.node?.expression?.kind === "callExpression"
            ? projection.node
            : program.effectNode(constraint.site),
          constraint.site,
        );
      }
    }
    for (const [collection, list] of each(work, "indexSteps", found)) {
      const positions: number[] = [];
      const texts = new Map<number, number[]>();
      const owners: (Callable | null)[] = [];
      const seen = new Set<Callable | null>();
      let inBlock = false;
      for (const entry of each(work, "indexSteps", list)) {
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
      sorted(work, "indexSteps", positions, (a, b) => a - b);
      for (const offsets of each(work, "indexSteps", texts.values()))
        sorted(work, "indexSteps", offsets, (a, b) => a - b);
      this.#invalidations.set(collection, { positions, texts, owners, inBlock });
    }
  }

  /** A collection key's invalidations (N2), or `undefined` without one. */
  public invalidations(key: Key): Invalidations | undefined {
    this.program.work.charge("eventSteps");
    return this.#invalidations.get(key);
  }

  /** Whether a test names a path of `root` (a read of any other root has no narrowing definition). */
  public tests(root: PlaceId): boolean {
    this.program.work.charge("eventSteps");
    return this.#tested.has(root);
  }

  /** The nearest narrowing definition of `location` whose region holds `node` (N2): a binary search and a climb. */
  public nearest(location: string, node: FlowNode): Narrowing | null {
    this.program.work.charge("eventSteps");
    const program = this.program;
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
    this.program.work.charge("eventSteps");
    return this.#byLocation.get(location)?.items ?? [];
  }

  /** The narrowing definitions of a refined location at a guarded region's entry, in evaluation order. */
  public atEntry(node: FlowNode, location: string): readonly Narrowing[] {
    this.program.work.charge("eventSteps");
    return this.#atEntry.get(joinParts(node.id, location)) ?? [];
  }

  /**
   * The nearest narrowing definition of a read at `node` (N2): of its own path's text, and of each element scope of its
   * trailing element steps (`rows[i][j]` asks `rows[i][*]` and `rows[*][*]`; `rows[i + 1][0]` only `rows[*][*]`, as no
   * tested path holds a computed step), the deepest region wins. One walk of the read's steps down the trie of tested
   * paths, asking only the scopes a test defines: linear in the read's path.
   */
  public nearestAt(node: FlowNode): Narrowing | null {
    this.program.work.charge("eventSteps");
    const program = this.program;
    const expression = node.expression;
    if (expression === undefined) return null;
    const path = stablePath(program, node.file, expression, true);
    if (path === null) return null;
    const work = program.work;
    const walk = path.steps;
    // the trailing element steps start at `first`
    let first = walk.length;
    for (const _ of steps(
      work,
      "eventSteps",
      () => first > 0 && readsElement(walk[first - 1]!, work),
    ))
      first -= 1;
    let best: Narrowing | null = null;
    let at = this.#tested.get(path.root);
    let length = 0;
    for (const _ of steps(work, "eventSteps", () => at !== undefined)) {
      const location = length >= first ? at!.locations.get(walk.length - length) : undefined;
      const g = location === undefined ? null : this.nearest(location, node);
      // (at an equal region the later, more specific scope wins: the read's own path last)
      if (g !== null && (best === null || !nearer(program, best, g))) best = g;
      if (length === walk.length) break;
      at = at!.children.get(stepLabel(walk[length]!, work));
      length += 1;
    }
    return best;
  }
}

/** Whether `a` lies inside `b`'s region: an operand region inside a branch's, or the deeper of two of a kind. */
function nearer(program: CoreProgram, a: Narrowing, b: Narrowing): boolean {
  program.work.charge("eventSteps");
  if ((a.region === null) !== (b.region === null)) return a.region !== null;
  return a.region !== null && b.region !== null
    ? a.region.start > b.region.start
    : program.position(a.node) > program.position(b.node);
}

/** The labels of a path's first `length` steps followed by `elements` element steps, each made charged. */
function labelsOf(path: StablePath, elements: number, length: number, work: WorkLedger): string[] {
  work.charge("eventSteps");
  const labels: string[] = [];
  let index = 0;
  for (const _ of steps(work, "eventSteps", () => index < length + elements)) {
    labels.push(index < length ? stepLabel(path.steps[index]!, work) : "[*]");
    index += 1;
  }
  return labels;
}

/**
 * The refined location of a path's first `length` steps followed by `elements` element steps, its labels made charged;
 * its text charged too where a structure keeps it (`kept`), made plain where a step only looks it up.
 */
export function locationOf(
  path: StablePath,
  work: WorkLedger,
  elements = 0,
  kept = false,
  length = path.steps.length,
): string {
  work.charge("eventSteps");
  const labels = labelsOf(path, elements, length, work);
  return kept ? keptParts(work, path.root, labels) : joinParts(path.root, labels);
}

/** The stores that add to a collection (an `add`, `addAll`, a dict's new entry): F5's adds. */
const ADDS: ReadonlySet<string> = new Set(["element", "elements", "entry"]);

/** Whether a method changes the collection it is called on in place (`ListMethod.changes`, `DictMethod.changes`). */
function mutates(name: string, work: WorkLedger): boolean {
  work.charge("indexSteps");
  return (listMethod(name)?.changes ?? dictMethod(name)?.changes) !== undefined;
}

/**
 * A `switch` case's form (N1): `case null`, or one literal by its value's kind (the shared `caseLiteral`): a whole
 * number as `is integer`, a fractional one as `is number` without `integer`, text, a truth value, a duration, a calendar
 * duration or an angle as `is` its kind; other cases (several values, a range, `case is T`) none.
 */
function caseForm(
  values: readonly Expression[],
  typeTest: { readonly negated: boolean } | null,
  work: WorkLedger,
): NarrowingForm | null {
  work.charge("indexSteps");
  if (typeTest !== null || values.length !== 1) return null;
  const literal = literalOf(values[0]!, work);
  if (literal === undefined) return null;
  if (literal.of === "null") return ONLY_NULL;
  return literal.of === "number"
    ? { kind: "is", kinds: ["number"], fractional: true }
    : { kind: "is", kinds: [literal.of] };
}
