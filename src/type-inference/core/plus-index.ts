import type { PlaceId } from "../graph.js";
import type { CorePass } from "./answers.js";
import { unknownItem } from "./contract/kinds.js";
import { keyOf, keyPlace } from "./definitions.js";
import type { FlowNode } from "./flow-graph.js";
import {
  firstWriter,
  makeItem,
  mergeItems,
  REASON,
  weaken,
  type Item,
  type Writer,
} from "./items.js";
import type { ValueConstraint } from "./program.js";
import type { Work } from "./solver.js";

// #1384: a run of `+`'s terms by the properties their objects hold, read below its elements one property at a time.

/** A closed term's objects (`shapeOf`): their first properties, borrowed, and the earliest of them. */
interface Shape {
  readonly names: readonly string[];
  readonly writer: Writer | null;
}

/** A binding's closed initializer (`bindingProof`): where it is stored, and its literal's shape. */
interface Proof {
  readonly node: FlowNode;
  readonly shape: Shape;
}

/**
 * An indexed run: its terms in source order, per first property the positions of the terms holding it, and a tree of
 * the terms' earliest objects (`width` leaves from `width` on, each inner slot the earlier of its two below).
 */
interface Run {
  readonly terms: readonly PlaceId[];
  readonly holders: ReadonlyMap<string, readonly number[]>;
  readonly width: number;
  readonly earliest: readonly (Writer | null)[];
}

/** A `+` of an indexed run: the terms from `lo` to before `hi`. */
export interface PlusSpan {
  readonly run: Run;
  readonly lo: number;
  readonly hi: number;
}

/** What an index shares in its pass once made: proofs per literal, binding and term, and every run's spans. */
interface Indexed {
  /** The roots a store or an add below them changes. */
  readonly below: ReadonlySet<PlaceId>;
  readonly shapes: Map<PlaceId, Shape | null>;
  readonly bindings: Map<PlaceId, Proof | null>;
  readonly terms: Map<PlaceId, Shape | null>;
  /** Per `+`, its span in its run; `null` for a run that is not indexed. */
  readonly spans: Map<PlaceId, PlusSpan | null>;
}

/**
 * A pass's state of the index (`Contract.plusIndex`): the first property any `+` was asked at, per `+` the first other
 * one, and the index once a `+` is asked at a second other one (`plusSpan`).
 */
export interface PlusIndex {
  readonly seed: string;
  readonly seen: Map<PlaceId, string>;
  indexed: Indexed | null;
}

/** Whether a value is a `+` of two operands, which a run may hold (`plusSpan`). */
export function isPlusValue(pass: CorePass, value: PlaceId): boolean {
  return isPlus(pass.program.opOf.get(value));
}

function isPlus(
  c: ValueConstraint | undefined,
): c is Extract<ValueConstraint, { readonly kind: "operation" }> {
  return (
    c?.kind === "operation" &&
    c.contract.family === "operator" &&
    c.contract.name === "+" &&
    c.arguments.length === 2
  );
}

/**
 * A `+`'s span among the terms of its run, asked below its elements at the property `step`. A run is the outermost
 * `+` reached up through `+` operands, with every `+` below it through theirs. It keeps its operations' walk until one
 * of its `+` is asked at a third property: the pass's first one, asked of any `+`, and a first other one per `+` cost a
 * walk each, which stays linear; a second other one indexes the whole run, which from then on answers each property it
 * is asked at, the first included. `null` where the walk answers: before that, or for a run admission rejected an
 * operand of (A6, `joinElements`) or with a term that is not closed (`termOf`), which is found once.
 */
export function plusSpan(pass: CorePass, value: PlaceId, step: string): PlusSpan | null {
  const { program, contract } = pass;
  if (!isPlus(program.opOf.get(value)) || step.includes("#")) return null;
  let state = contract.plusIndex;
  if (state === null) {
    contract.keep(3);
    state = contract.plusIndex = { seed: step, seen: new Map(), indexed: null };
  }
  const known = state.indexed?.spans.get(value);
  if (known !== undefined) return known;
  if (step === state.seed) return null;
  const first = state.seen.get(value);
  if (first === undefined) {
    contract.keep(2);
    state.seen.set(value, step);
    return null;
  }
  return first === step ? null : runSpan(pass, state.indexed ?? indexed(pass, state), value);
}

/** The index's shared parts, made at its first run. */
function indexed(pass: CorePass, state: PlusIndex): Indexed {
  const { program, contract } = pass;
  const below = new Set<PlaceId>();
  contract.keep(5);
  for (const key of pass.definitions.byKey.keys()) {
    program.work.charge("indexSteps");
    if (!key.endsWith("|")) below.add(keyPlace(key));
  }
  contract.keep(below.size);
  state.indexed = {
    below,
    shapes: new Map(),
    bindings: new Map(),
    terms: new Map(),
    spans: new Map(),
  };
  return state.indexed;
}

/**
 * The run of `value`'s `+` indexed: its spans published once its positions and tree are complete and kept, so a stop
 * while it is made leaves no run; a run that is not indexed is found once for every `+` in it.
 */
function runSpan(pass: CorePass, ix: Indexed, value: PlaceId): PlusSpan | null {
  const { program, contract, lists } = pass;
  const work = program.work;
  // (the run's root: each `+` up the operands' consumers, to one no `+` takes; an operand of two leaves each `+` on
  // the way to its walk)
  const above: PlaceId[] = [];
  let root = value;
  for (;;) {
    let parent: PlaceId | null = null;
    for (const use of program.consumersOf.get(root) ?? []) {
      work.charge("indexSteps");
      if (use.kind !== "operand" || !isPlus(use.operation)) continue;
      if (parent !== null && parent !== use.operation.result) {
        contract.keep(2 * above.length + 2);
        for (const operation of [value, ...above]) ix.spans.set(operation, null);
        return null;
      }
      parent = use.operation.result;
    }
    if (parent === null) break;
    above.push(parent);
    root = parent;
  }
  const terms: PlaceId[] = [];
  const shapes: Shape[] = [];
  const spans: { readonly value: PlaceId; readonly lo: number; hi: number }[] = [];
  // (the terms in source order, each `+`'s span closed after its right operand's)
  const stack: { readonly value: PlaceId; readonly span: (typeof spans)[number] | null }[] = [
    { value: root, span: null },
  ];
  let closed = true;
  while (stack.length > 0) {
    const top = stack.pop()!;
    work.charge("indexSteps");
    if (top.span !== null) {
      top.span.hi = terms.length;
      continue;
    }
    const c = program.opOf.get(top.value);
    if (isPlus(c)) {
      if (!c.arguments.every((operand) => lists.joined(operand))) closed = false;
      const span = { value: top.value, lo: terms.length, hi: 0 };
      spans.push(span);
      stack.push(
        { value: top.value, span },
        { value: c.arguments[1]!, span: null },
        { value: c.arguments[0]!, span: null },
      );
      continue;
    }
    const shape = termOf(pass, ix, top.value);
    if (shape === null) closed = false;
    else {
      terms.push(top.value);
      shapes.push(shape);
    }
  }
  contract.keep(3 * spans.length + terms.length);
  if (!closed) {
    for (const span of spans) ix.spans.set(span.value, null);
    return null;
  }
  const holders = new Map<string, number[]>();
  for (const [index, shape] of shapes.entries())
    for (const name of shape.names) {
      work.charge("indexSteps");
      let list = holders.get(name);
      if (list === undefined) holders.set(name, (list = []));
      list.push(index);
      contract.keep(1);
    }
  let width = 1;
  while (width < terms.length) width *= 2;
  contract.keep(2 * width + holders.size);
  const earliest: (Writer | null)[] = new Array<Writer | null>(2 * width).fill(null);
  for (const [index, shape] of shapes.entries()) earliest[width + index] = shape.writer;
  for (let index = width - 1; index > 0; index -= 1) {
    work.charge("indexSteps");
    earliest[index] = firstWriter(earliest[2 * index]!, earliest[2 * index + 1]!);
  }
  const run: Run = { terms, holders, width, earliest };
  for (const { value: operation, lo, hi } of spans) ix.spans.set(operation, { run, lo, hi });
  return ix.spans.get(value)!;
}

/**
 * A term of a run as a closed shape: a list literal's (`shapeOf`), or a read's whose binding's closed initializer
 * (`bindingProof`) dominates its node, so that initializer is its reaching definition (X2). `null` for any other term.
 */
function termOf(pass: CorePass, ix: Indexed, value: PlaceId): Shape | null {
  const known = ix.terms.get(value);
  if (known !== undefined) return known;
  const { program, contract } = pass;
  program.work.charge("indexSteps");
  const binding = program.occurrenceOf.get(value);
  let shape: Shape | null;
  if (binding === undefined) shape = shapeOf(pass, ix, value);
  else {
    const proof = bindingProof(pass, ix, binding);
    const node = program.occNode.get(value) ?? null;
    shape =
      proof !== null && node !== null && program.dom.dominates(proof.node, node)
        ? proof.shape
        : null;
  }
  contract.keep(2 + (shape === null ? 0 : 1));
  ix.terms.set(value, shape);
  return shape;
}

/**
 * A binding whose reads may be closed terms: its one definition a whole initializer of a closed literal (`shapeOf`),
 * live as X2 lists it (A6's rejected, unreachable and loop definitions left out), no written type, no test of it
 * (§3.2) and no store below it. `null` otherwise.
 */
function bindingProof(pass: CorePass, ix: Indexed, binding: PlaceId): Proof | null {
  const known = ix.bindings.get(binding);
  if (known !== undefined) return known;
  const { program, contract, definitions, lists, guards } = pass;
  const key = keyOf(binding, []);
  const own = definitions.byKey.get(key) ?? [];
  const live = lists.definitionsOf(key).list;
  const kind = program.place(binding).kind;
  let proof: Proof | null = null;
  if (
    guards.untested(binding) &&
    !ix.below.has(binding) &&
    own.length === 1 &&
    live.length === 1 &&
    live[0] === own[0] &&
    own[0]!.kind === "whole" &&
    own[0]!.how === "initializer" &&
    own[0]!.value !== undefined &&
    kind.kind === "binding" &&
    kind.written === null
  ) {
    const shape = shapeOf(pass, ix, own[0]!.value);
    if (shape !== null) proof = { node: own[0]!.node, shape };
  }
  contract.keep(2 + (proof === null ? 0 : 2));
  ix.bindings.set(binding, proof);
  return proof;
}

/**
 * A list literal whose elements answer from it alone at every property: at least one element, each an object, and
 * nothing below it but literals' own terms (no read, computed value, reference kind or element without a cell). `null`
 * for any other value.
 */
function shapeOf(pass: CorePass, ix: Indexed, literal: PlaceId): Shape | null {
  const known = ix.shapes.get(literal);
  if (known !== undefined) return known;
  const { program, contract } = pass;
  program.work.charge("indexSteps");
  const shape = closedShape(pass, literal);
  contract.keep(2);
  ix.shapes.set(literal, shape);
  return shape;
}

function closedShape(pass: CorePass, literal: PlaceId): Shape | null {
  const { program, contract } = pass;
  const kind = program.places[literal]?.kind;
  if (kind?.kind !== "value" || kind.node !== "listLiteral") return null;
  const root = contract.literalIndex(literal).root;
  const element = root.children.get("element");
  if (
    root.terms.size !== 1 ||
    !root.terms.has("list") ||
    element === undefined ||
    element.terms.size !== 1 ||
    !element.terms.has("object") ||
    element.objects === null ||
    element.objects.list.length === 0 ||
    element.empty
  )
    return null;
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    program.work.charge("indexSteps");
    if (
      node.reads.length > 0 ||
      node.exact.length > 0 ||
      node.others.length > 0 ||
      node.reference ||
      node.empty
    )
      return null;
    for (const child of node.children.values()) pending.push(child);
  }
  const names = [...element.children.keys()];
  let writer: Writer | null = null;
  for (const object of element.objects.list) {
    program.work.charge("indexSteps");
    writer = firstWriter(writer, object.token);
  }
  contract.keep(2 + names.length);
  return { names, writer };
}

/** The first of `positions` at or after `at`. */
function firstFrom(pass: CorePass, positions: readonly number[], at: number): number {
  let low = 0;
  let high = positions.length;
  while (low < high) {
    pass.program.work.charge("indexSteps");
    const middle = (low + high) >> 1;
    if (positions[middle]! < at) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** The earliest object of the run's terms from `from` to before `to`. */
function earliestOf(pass: CorePass, run: Run, from: number, to: number): Writer | null {
  let writer: Writer | null = null;
  for (let low = from + run.width, high = to + run.width; low < high; low >>= 1, high >>= 1) {
    pass.program.work.charge("indexSteps");
    if ((low & 1) === 1) writer = firstWriter(writer, run.earliest[low++]!);
    if ((high & 1) === 1) writer = firstWriter(writer, run.earliest[--high]!);
  }
  return writer;
}

/**
 * A `+` of an indexed run (`plusSpan`) below its elements at a property, as its operands' walk answers there
 * (`plusElements`): each term holding the property by `read`, its side's own answer, and the terms between them,
 * whose objects all lack it, as their earliest object's missing property (F11), at that property or below it, with the
 * side's context; merged in the terms' order, possibilities (`member`) where more than one term gives an element.
 * `null` where the walk answers: a path not below an element's property, a `+` without an indexed span, or a term's
 * answer with an element step's mark.
 */
export function* indexedPlus(
  pass: CorePass,
  value: PlaceId,
  rest: readonly string[],
  exact: boolean,
  read: (term: PlaceId) => Work<readonly Item[]>,
): Work<Item[] | null> {
  if (rest.length < 2 || rest[0] !== "element") return null;
  const step = rest[1]!;
  const span = plusSpan(pass, value, step);
  if (span === null) return null;
  const { run, lo, hi } = span;
  const holders = run.holders.get(step) ?? [];
  const operands: (readonly Item[])[] = [];
  let at = lo;
  let giving = 0;
  for (let index = firstFrom(pass, holders, lo), end = firstFrom(pass, holders, hi); ; index += 1) {
    const holder = index < end ? holders[index]! : hi;
    if (holder > at) {
      const writer = earliestOf(pass, run, at, holder);
      operands.push([
        exact
          ? makeItem("unknown", writer, { reasons: REASON.missing, context: "missing" })
          : unknownItem(REASON.missing, writer),
      ]);
      giving += holder - at;
    }
    if (index === end) break;
    pass.program.work.charge("indexSteps");
    const items = yield* read(run.terms[holder]!);
    if (items.some((item) => item.tag === "empty")) return null;
    operands.push(items);
    if (items.length > 0) giving += 1;
    at = holder + 1;
  }
  const items = mergeItems(operands.flat(), pass.program.scope);
  return giving > 1 ? weaken(items, "member") : items;
}
