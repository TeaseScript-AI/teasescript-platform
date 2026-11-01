import type { PlaceId } from "../graph.js";
import type { CorePass } from "./answers.js";
import { unknownItem } from "./contract/kinds.js";
import { keyOf, keyPlace, sortCost } from "./definitions.js";
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
import type { CoreProgram, ValueConstraint } from "./program.js";
import { sharing } from "./sharing.js";
import type { Work } from "./solver.js";

// #1384: a run of `+`'s terms by the properties their objects hold, read below its elements one property at a time.

/** A closed term's objects (`shapeOf`): their first properties, borrowed, and the earliest of them. */
interface Shape {
  readonly names: readonly string[];
  readonly writer: Writer | null;
}

/** A binding's closed initializer (`bindingProof`): where it is stored, its literal's shape and that one's names. */
interface Proof {
  readonly node: FlowNode;
  readonly shape: Shape;
  readonly names: ReadonlySet<string>;
}

/** A closed term (`termOf`): its shape, and for a read the proof every read of its binding shares, else `null`. */
interface Term {
  readonly shape: Shape;
  readonly read: Proof | null;
}

/** A run's reads of one binding: their positions in order. Each answers as the others at every path (`termOf`). */
interface Reads {
  readonly proof: Proof;
  readonly positions: readonly number[];
}

/**
 * A root's indexed run: its terms in source order; per first property the positions of the literals holding it (a
 * literal stands once, in one run); per binding read its reads (`reads` by their first position, `byWriter` by their
 * earliest object, `groupOf` by proof), whose properties are never posted, so a binding of k properties read k times is
 * k positions, not k² postings (#1384, Codex r1); per property asked, the bindings holding it (`holding`, found once:
 * `holdersOf`); per position the first literal at or after it; and a tree of the literals' earliest objects (`width`
 * leaves from `width` on, a read's `null`, each inner slot the earlier of its two below).
 */
interface Run {
  readonly terms: readonly PlaceId[];
  readonly holders: ReadonlyMap<string, readonly number[]>;
  readonly reads: readonly Reads[];
  readonly byWriter: readonly Reads[];
  readonly groupOf: ReadonlyMap<Proof, Reads>;
  readonly holding: Map<string, ReadonlySet<Reads>>;
  readonly nextLiteral: readonly number[];
  readonly width: number;
  readonly earliest: readonly (Writer | null)[];
}

/** What an index shares in its pass once made: proofs per literal, binding and term, and every root's run. */
interface Indexed {
  /** The roots a store or an add below them changes. */
  readonly below: ReadonlySet<PlaceId>;
  readonly shapes: Map<PlaceId, Shape | null>;
  readonly bindings: Map<PlaceId, Proof | null>;
  readonly terms: Map<PlaceId, Term | null>;
  /** Per first property, the closed bindings holding it, each once in the pass (`bindingProof`). */
  readonly bindingsHolding: Map<string, Proof[]>;
  /** Per root, its run; `null` for a run that is not indexed. */
  readonly runs: Map<PlaceId, Run | null>;
}

/**
 * A pass's state of the index (`Contract.plusIndex`): the first property any `+` was asked at, per root the first other
 * one, and the index once a root is asked at a second other one (`plusRun`).
 */
export interface PlusIndex {
  readonly seed: string;
  readonly seen: Map<PlaceId, string>;
  indexed: Indexed | null;
}

/**
 * The steps the index's queries took so far in this process (`visit`), each charged before it is taken: the work test
 * compares them with the charged `indexSteps` (the holder bound, Codex r2 on #1562).
 */
let visits = 0;

/** The steps the index's queries took so far in this process (`visit`): the work test's count. */
export function plusIndexVisits(): number {
  return visits;
}

/** One step of a query, charged before it runs (the holder bound). */
function visit(program: CoreProgram): void {
  visits += 1;
  program.work.charge("indexSteps");
}

/** Whether a value is a `+` of two operands, which a run may hold (`plusRun`). */
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
 * A root's indexed run, asked below its elements at the property `step` on one side (`exact`: the value side). A run
 * is a `+` no `+` takes as an operand, its root, with every `+` below it through their operands; only its root answers
 * from the index, every `+` below it keeps its walk. It keeps its root's walk until its root is asked at a third
 * property: the pass's first one, asked of any `+`, and a first other one per root cost a walk each, which stays
 * linear; a second other one indexes the run, which from then on answers each property its root is asked at, the
 * first included. `null` where the walk answers: before that, below a root, for a run whose walk on that side the
 * collapse already answers (`collapsed`), or for a run admission rejected an operand of (A6, `joinElements`) or with a
 * term that is not closed (`termOf`), which is found once.
 */
export function plusRun(pass: CorePass, value: PlaceId, step: string, exact: boolean): Run | null {
  const { program, contract } = pass;
  if (!isPlus(program.opOf.get(value)) || step.includes("#")) return null;
  let state = contract.plusIndex;
  if (state === null) {
    contract.keep(3);
    state = contract.plusIndex = { seed: step, seen: new Map(), indexed: null };
  }
  const known = state.indexed?.runs.get(value);
  if (known !== undefined) return known;
  if (step === state.seed || !isRoot(program, value)) return null;
  const first = state.seen.get(value);
  if (first === undefined) {
    contract.keep(2);
    state.seen.set(value, step);
    return null;
  }
  return first === step || collapsed(pass, value, exact)
    ? null
    : runOf(pass, state.indexed ?? indexed(pass, state), value);
}

/** Whether no `+` takes a value as an operand: a run's root (`plusRun`). */
function isRoot(program: CoreProgram, value: PlaceId): boolean {
  for (const use of program.consumersOf.get(value) ?? [])
    if (use.kind === "operand" && isPlus(use.operation)) return false;
  return true;
}

/**
 * TABLE r4.87: whether a run is one class along its left operands down to its terms on one side, the sharing on
 * (`plusRepeatOf`, which that side's walk asks next): its root answers below its elements as its third, whose walk
 * reads three `+` and four terms, so each property its root is asked at costs a few steps, and an index would only add
 * its own work.
 */
function collapsed(pass: CorePass, root: PlaceId, exact: boolean): boolean {
  if (!sharing()) return false;
  const { program, contract } = pass;
  const operands = (value: PlaceId): readonly PlaceId[] | null => {
    const c = program.opOf.get(value);
    return isPlus(c) ? c.arguments : null;
  };
  const third = contract.plusRepeatOf(root, exact);
  if (third === root) return false;
  // (the third, the second and the first `+` of its run, and the terms they join)
  const own = operands(third)!;
  const second = operands(own[0]!);
  const first = second === null ? null : operands(second[0]!);
  return (
    first !== null &&
    [first[0]!, first[1]!, second![1]!, own[1]!].every((operand) => operands(operand) === null)
  );
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
    bindingsHolding: new Map(),
    runs: new Map(),
  };
  return state.indexed;
}

/**
 * The run of a root (`plusRun`) indexed: published once its positions, groups and tree are complete and kept, so a
 * stop while it is made leaves no run; a run that is not indexed is found once.
 */
function runOf(pass: CorePass, ix: Indexed, root: PlaceId): Run | null {
  const { program, contract, lists } = pass;
  const work = program.work;
  const terms: PlaceId[] = [];
  const kinds: Term[] = [];
  // (the terms in source order)
  const stack: PlaceId[] = [root];
  let closed = true;
  while (stack.length > 0) {
    const top = stack.pop()!;
    work.charge("indexSteps");
    const c = program.opOf.get(top);
    if (isPlus(c)) {
      if (!c.arguments.every((operand) => lists.joined(operand))) closed = false;
      stack.push(c.arguments[1]!, c.arguments[0]!);
      continue;
    }
    const term = termOf(pass, ix, top);
    if (term === null) closed = false;
    else {
      terms.push(top);
      kinds.push(term);
    }
  }
  contract.keep(2 + terms.length);
  if (!closed) {
    ix.runs.set(root, null);
    return null;
  }
  // (a literal's names posted at its position, a literal standing once in one run; a binding's reads by its proof)
  const holders = new Map<string, number[]>();
  const groupOf = new Map<Proof, Reads>();
  const positionsOf = new Map<Proof, number[]>();
  const reads: Reads[] = [];
  for (const [index, { shape, read }] of kinds.entries()) {
    work.charge("indexSteps");
    if (read !== null) {
      let positions = positionsOf.get(read);
      if (positions === undefined) {
        contract.keep(3);
        positionsOf.set(read, (positions = []));
        const group = { proof: read, positions };
        groupOf.set(read, group);
        reads.push(group);
      }
      positions.push(index);
      contract.keep(1);
      continue;
    }
    for (const name of shape.names) {
      work.charge("indexSteps");
      let list = holders.get(name);
      if (list === undefined) holders.set(name, (list = []));
      list.push(index);
      contract.keep(1);
    }
  }
  // (the groups by their earliest objects, which no two bindings share)
  work.charge("indexSteps", sortCost(reads.length));
  contract.keep(reads.length);
  const byWriter = [...reads].sort((a, b) =>
    a === b
      ? 0
      : firstWriter(a.proof.shape.writer, b.proof.shape.writer) === a.proof.shape.writer
        ? -1
        : 1,
  );
  let width = 1;
  while (width < terms.length) width *= 2;
  contract.keep(2 * width + holders.size + terms.length + 2);
  const earliest: (Writer | null)[] = new Array<Writer | null>(2 * width).fill(null);
  const nextLiteral: number[] = new Array<number>(terms.length + 1);
  nextLiteral[terms.length] = terms.length;
  for (let index = terms.length - 1; index >= 0; index -= 1) {
    work.charge("indexSteps");
    const literal = kinds[index]!.read === null;
    if (literal) earliest[width + index] = kinds[index]!.shape.writer;
    nextLiteral[index] = literal ? index : nextLiteral[index + 1]!;
  }
  for (let index = width - 1; index > 0; index -= 1) {
    work.charge("indexSteps");
    earliest[index] = firstWriter(earliest[2 * index]!, earliest[2 * index + 1]!);
  }
  const run: Run = {
    terms,
    holders,
    reads,
    byWriter,
    groupOf,
    holding: new Map(),
    nextLiteral,
    width,
    earliest,
  };
  ix.runs.set(root, run);
  return run;
}

/**
 * The bindings a run reads that hold a property, found once per run and property through the pass's bindings holding
 * it (`bindingsHolding`) or the run's own, whichever are fewer, each step charged before it runs: the holder bound's one
 * exception, at most the run's own bindings once per run and property, a walk of the run on `main` costing as much.
 */
function holdersOf(pass: CorePass, ix: Indexed, run: Run, step: string): ReadonlySet<Reads> {
  const known = run.holding.get(step);
  if (known !== undefined) return known;
  const { program, contract } = pass;
  const holding = new Set<Reads>();
  const proofs = ix.bindingsHolding.get(step) ?? [];
  if (proofs.length <= run.reads.length)
    for (const proof of proofs) {
      visit(program);
      const group = run.groupOf.get(proof);
      if (group !== undefined) holding.add(group);
    }
  else
    for (const group of run.reads) {
      visit(program);
      if (group.proof.names.has(step)) holding.add(group);
    }
  contract.keep(2 + holding.size);
  run.holding.set(step, holding);
  return holding;
}

/**
 * A term of a run as a closed shape: a list literal's (`shapeOf`), or a read's whose binding's closed initializer
 * (`bindingProof`) dominates its node, so that initializer is its reaching definition (X2): every such read of one
 * binding has its value, untested, so it answers as the others at every path. `null` for any other term.
 */
function termOf(pass: CorePass, ix: Indexed, value: PlaceId): Term | null {
  const known = ix.terms.get(value);
  if (known !== undefined) return known;
  const { program, contract } = pass;
  program.work.charge("indexSteps");
  const binding = program.occurrenceOf.get(value);
  let term: Term | null;
  if (binding === undefined) {
    const shape = shapeOf(pass, ix, value);
    term = shape === null ? null : { shape, read: null };
  } else {
    const proof = bindingProof(pass, ix, binding);
    const node = program.occNode.get(value) ?? null;
    term =
      proof !== null && node !== null && program.dom.dominates(proof.node, node)
        ? { shape: proof.shape, read: proof }
        : null;
  }
  contract.keep(2 + (term === null ? 0 : 2));
  ix.terms.set(value, term);
  return term;
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
    if (shape !== null) {
      // (its names once per binding, whatever reads it, as a set and posted in the pass: `holdersOf`)
      program.work.charge("indexSteps", 2 * shape.names.length);
      contract.keep(3 + 3 * shape.names.length);
      proof = { node: own[0]!.node, shape, names: new Set(shape.names) };
      for (const name of shape.names) {
        let list = ix.bindingsHolding.get(name);
        if (list === undefined) ix.bindingsHolding.set(name, (list = []));
        list.push(proof);
      }
    }
  }
  contract.keep(2);
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

/** The earliest object of the run's literals from `from` to before `to`. */
function earliestOf(pass: CorePass, run: Run, from: number, to: number): Writer | null {
  let writer: Writer | null = null;
  for (let low = from + run.width, high = to + run.width; low < high; low >>= 1, high >>= 1) {
    visit(pass.program);
    if ((low & 1) === 1) writer = firstWriter(writer, run.earliest[low++]!);
    if ((high & 1) === 1) writer = firstWriter(writer, run.earliest[--high]!);
  }
  return writer;
}

/**
 * A run's root (`plusRun`) below its elements at a property, as its operands' walk answers there (`plusElements`):
 * each literal holding the property and the first read of each binding holding it by `read`, its side's own answer,
 * and the terms whose objects all lack it as their earliest object's missing property (F11), at that property or below
 * it, with the side's context, where the first of them stands; merged in the terms' order (a kind keeps its first
 * item's place, so a read again and a missing property again add nothing), possibilities (`member`) where more than
 * one term gives an element. Its steps are the holder bound's: one per literal and binding holding the property, one
 * per step of the literals' tree between them, and one in each order of the run's bindings to the first lacking it,
 * each charged before it runs (`visit`), its fixed work on one more. `null` where the walk answers: a path not below an
 * element's property, a `+` that is no indexed root, or a term's answer with an element step's mark.
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
  const run = plusRun(pass, value, step, exact);
  if (run === null) return null;
  const { program } = pass;
  visit(program);
  const length = run.terms.length;
  // (each contribution where it first stands; `empty`: the terms giving no element)
  const parts: { readonly at: number; readonly items: readonly Item[] }[] = [];
  let missingAt = length;
  let missingWriter: Writer | null = null;
  let empty = 0;
  const lacking = (at: number, writer: Writer | null): void => {
    missingAt = Math.min(missingAt, at);
    missingWriter = firstWriter(missingWriter, writer);
  };
  // the literals holding it, and those between them lacking it
  const holders = run.holders.get(step) ?? [];
  let at = 0;
  for (let index = 0; ; index += 1) {
    const holder = index < holders.length ? holders[index]! : length;
    if (run.nextLiteral[at]! < holder)
      lacking(run.nextLiteral[at]!, earliestOf(pass, run, at, holder));
    if (index === holders.length) break;
    visit(program);
    const items = yield* read(run.terms[holder]!);
    if (items.some((item) => item.tag === "empty")) return null;
    parts.push({ at: holder, items });
    if (items.length === 0) empty += 1;
    at = holder + 1;
  }
  // the bindings holding it, by their first reads; the earliest object and the first read of those lacking it
  const holding = holdersOf(pass, pass.contract.plusIndex!.indexed!, run, step);
  for (const group of holding) {
    visit(program);
    const items = yield* read(run.terms[group.positions[0]!]!);
    if (items.some((item) => item.tag === "empty")) return null;
    parts.push({ at: group.positions[0]!, items });
    if (items.length === 0) empty += group.positions.length;
  }
  for (const group of run.byWriter) {
    visit(program);
    if (!holding.has(group)) {
      lacking(group.positions[0]!, group.proof.shape.writer);
      break;
    }
  }
  for (const group of run.reads) {
    visit(program);
    if (!holding.has(group)) {
      lacking(group.positions[0]!, null);
      break;
    }
  }
  if (missingAt < length)
    parts.push({
      at: missingAt,
      items: [
        exact
          ? makeItem("unknown", missingWriter, { reasons: REASON.missing, context: "missing" })
          : unknownItem(REASON.missing, missingWriter),
      ],
    });
  program.work.charge("indexSteps", sortCost(parts.length));
  parts.sort((a, b) => a.at - b.at);
  const items = mergeItems(
    parts.flatMap((part) => part.items),
    program.scope,
  );
  return length - empty > 1 ? weaken(items, "member") : items;
}
