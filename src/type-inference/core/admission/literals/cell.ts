// A literal's cell: the type all its elements fit at one path (#2289, ADR 0021 1.3, V30 §12, §40).
import type { PlaceId, SourceSite, TypeTerm } from "../../../graph.js";
import type { Admission } from "../../admission.js";
import { typeTags } from "../../contract.js";
import { sortCost, type Key } from "../../definitions.js";
import { restRef, stepsAfter } from "../../contract/key-ids.js";
import type { FlowNode } from "../../flow-graph.js";
import { type ItemTag, REASON } from "../../items.js";
import { withoutEmpty } from "../../exact-path.js";
import type { Expansion, Inheriting, View } from "../model.js";
import { scanView, textDepth, type DeciderAnswer } from "../scan.js";
import { cellSteps, expandRead, partOfRead, viaSignature, viewOfRead } from "../walk.js";
import { sourceOfRead } from "../structure.js";
import { isRead, type Reads } from "../../inherited/reads.js";
import { joinSteps, keep, keepText, keptParts, keptSteps, stepText } from "../../budget.js";
import { sharing } from "../../sharing.js";

/**
 * An element of a cell at one path as the fitting reads it: its kinds there without `null` (none where it decides
 * nothing), whether it may be `null`, and whether it is declared (its written type, a copy of one, a typed host value,
 * an element of a written collection: its scan's `term`) or inferred (its value's kinds, by family).
 */
export interface Descriptor {
  readonly value: PlaceId;
  readonly tags: readonly ItemTag[];
  readonly term: TypeTerm | null;
  readonly nullable: boolean;
  readonly site: SourceSite | null;
  readonly own: boolean;
  /** It decides nothing and may hold host data there (an external unknown): its value is checked where it leaves. */
  readonly host: boolean;
}

/**
 * A cell's answer at a path (B1): `fit`, the kinds every element fits (rule 1 or 2), strict where a declared element
 * has exactly them (rule 5), its term then the earliest such element's; `conflict`, none fits all (rule 3), the
 * earliest element's type counting, and each later element that does not fit it a misfit, by value (`misfits`);
 * `none`, no element decides; `stopped`, an element's value a stop left unknown, so the cell is undecided (R26).
 */
export type CellAnswer =
  | {
      readonly kind: "fit";
      readonly tags: readonly ItemTag[];
      readonly strict: boolean;
      /** The deciding element's written type (`strict` only), `null` added where a declared element's holds it. */
      readonly term: TypeTerm | null;
      readonly nullable: boolean;
      readonly site: SourceSite | null;
      readonly own: boolean;
      /** An element, or one nested in an element's literal, decides nothing and may hold host data (R38). */
      readonly host: boolean;
    }
  | {
      readonly kind: "conflict";
      readonly earliest: Descriptor;
      /** The later elements that do not fit the earliest's type (`misfits`), a copy R37 left out by its first's. */
      readonly misfits: ReadonlyMap<PlaceId, Descriptor>;
      readonly nullable: boolean;
      readonly host: boolean;
    }
  | { readonly kind: "none"; readonly nullable: boolean; readonly host: boolean }
  | { readonly kind: "stopped" };

/** Where a strict cell was asked: its literal's body, the steps below the literal, and the decision it is taken into. */
export interface CellSource {
  readonly body: Body;
  readonly rel: readonly string[];
  readonly into: Key | null;
}

/**
 * #2289 (R50): an element of a literal's body at a cell: its value, its position in the literal's source, the step it
 * stands at (`null` in a projection's body, where the cells stand at the literal's own path), the strip its reading
 * keeps, its recipe, and its view (`viewOfRead`), made when the body's index is first asked.
 */
export interface BodyScope {
  readonly position: number;
  readonly value: PlaceId;
  readonly node: FlowNode;
  readonly step: string | null;
  readonly strip: readonly string[];
  readonly expansion: Expansion;
  view: View | null;
}

/**
 * #2289 (R50): a literal's body for one reading of it (`strip` empty: whole; else through a projection, its cells the
 * strip's first step's), shared by every view that links it and by the comparisons: its elements by cell step, each
 * read as its own walk reads it (its recipe, its own context), a nested literal in one a link of that element's view,
 * never walked or copied again here. `index`: per local path, the elements with a stop or link there, made when first
 * asked. Once per literal, node and strip in the pass.
 */
export interface Body {
  readonly value: PlaceId;
  readonly node: FlowNode;
  readonly strip: readonly string[];
  readonly scopes: ReadonlyMap<string | null, readonly BodyScope[]>;
  /** Per cell step, each element R37 left out, by the first it copies (both by value). */
  readonly copies: ReadonlyMap<string | null, ReadonlyMap<PlaceId, PlaceId>>;
  index: {
    readonly reach: Map<string, BodyScope[]>;
    readonly exact: Map<string, BodyScope[]>;
  } | null;
}

/**
 * A literal's body for a reading (`Body`), once: its cell steps' elements, of the elements reading one source identity
 * at one snapshot the first (R37, with sharing on).
 */
export function* bodyOfRead(
  admission: Admission,
  value: PlaceId,
  node: FlowNode,
  strip: readonly string[],
): Reads<Body> {
  const name = `${value}\u0001${node.id}\u0001${strip.join("\u0001")}`;
  const known = admission.bodies.get(name);
  if (known !== undefined) return known;
  // (shared by every later reader: counted as `viewOfRead` counts a view, R53)
  return yield* admission.pass.program.work.sharedStructure(
    buildBody(admission, name, value, node, strip),
  );
}

function* buildBody(
  admission: Admission,
  name: string,
  value: PlaceId,
  node: FlowNode,
  strip: readonly string[],
): Reads<Body> {
  const { program, contract } = admission.pass;
  const task = yield* expandRead(admission, value, node, strip);
  program.work.charge("checks", task.parts.length);
  const cellular = cellSteps(task);
  const scopes = new Map<string | null, BodyScope[]>();
  const copies = new Map<string | null, Map<PlaceId, PlaceId>>();
  const firsts = new Map<string, PlaceId>();
  // (a literal's parts stand in its source order, `cells`: positions ascending)
  for (const part of task.parts) {
    if (!cellular.has(part.step)) continue;
    const snapshot = sharing()
      ? program.work.outside(() => contract.readSnapshot(part.value))
      : null;
    if (snapshot !== null) {
      const same = `${String(part.step)}\u0001${program.work.outside(() => contract.identityOf(part.value).id)}\u0001${snapshot}`;
      const first = firsts.get(same);
      if (first !== undefined) {
        let left = copies.get(part.step);
        if (left === undefined) copies.set(part.step, (left = new Map()));
        left.set(part.value, first);
        continue;
      }
      firsts.set(same, part.value);
    }
    const scope: BodyScope = {
      position: part.position,
      value: part.value,
      node: part.node,
      step: part.step,
      strip: part.strip,
      expansion: yield* partOfRead(admission, part),
      view: null,
    };
    keep(admission.work, 1);
    const list = scopes.get(part.step);
    if (list === undefined) scopes.set(part.step, [scope]);
    else list.push(scope);
  }
  const body: Body = { value, node, strip, scopes, copies, index: null };
  admission.bodies.set(name, body);
  return body;
}

/** A body's index (`Body.index`), once: each element's view, its maps' paths as the body's own (below its step). */
function* indexOf(admission: Admission, body: Body): Reads<NonNullable<Body["index"]>> {
  if (body.index !== null) return body.index;
  // (shared as a view is, R53)
  return yield* admission.pass.program.work.sharedStructure(buildIndex(admission, body));
}

function* buildIndex(admission: Admission, body: Body): Reads<NonNullable<Body["index"]>> {
  const { contract } = admission.pass;
  const { work } = admission.pass.program;
  const seen = new Set<string>();
  const reach = new Map<string, BodyScope[]>();
  const exact = new Map<string, BodyScope[]>();
  const add = (map: Map<string, BodyScope[]>, text: string, scope: BodyScope): void => {
    const list = map.get(text);
    if (list === undefined) map.set(text, [scope]);
    else if (list.at(-1) !== scope) list.push(scope);
  };
  for (const [step, list] of body.scopes)
    for (const scope of list) {
      const view = (scope.view ??= yield* viewOfRead(admission, scope.expansion));
      const mount = (text: string): string => {
        admission.pass.program.work.charge("checks");
        if (step === null) return text;
        keepText(admission.work, step.length + 1 + text.length);
        return text === "" ? step : stepText(step, text);
      };
      for (const map of [view.written, view.links])
        for (const text of map.keys()) add(reach, mount(text), scope);
      // (F2 across the body's elements: a value stop reading a source identity at a snapshot, through the same
      // operations, that an earlier element's view holds at the same path stands for nothing new, R37)
      for (const [text, stops] of view.values) {
        const at = mount(text);
        let fresh = !sharing() || at === "";
        for (const stop of stops) {
          if (fresh) break;
          if (
            (yield* work.outsideSteps(sourceOfRead(admission, stop.value))) === null ||
            work.outside(() => contract.ingressOf(stop.value)) !== null
          ) {
            fresh = true;
            break;
          }
          const identity = keptParts(
            admission.work,
            at,
            stop.strip,
            viaSignature(admission, stop.via),
            stop.deep,
            stop.single,
            work.outside(() => contract.identityOf(stop.value).id),
            work.outside(() => contract.readSnapshot(stop.value)) ?? "",
          );
          if (!seen.has(identity)) {
            seen.add(identity);
            fresh = true;
          }
        }
        if (fresh) add(reach, at, scope);
      }
      for (const text of view.literals.keys()) add(exact, mount(text), scope);
    }
  body.index = { reach, exact };
  return body.index;
}

/**
 * #2289 (R50): a literal's cell in its body at the steps below the literal (`rel`; whole, the cell's step first): B1
 * over the elements with a stop or link on the path, each element's descriptor its own view's scan (`scanView`) at the
 * rest below it, so a nested literal in it answers by its own body's cell. Answers are shared only as `memoCell` admits.
 */
export function* cellOfBody(
  admission: Admission,
  body: Body,
  rel: readonly string[],
  into: Key | null,
  batch: CellBatch | null = null,
): Inheriting<CellAnswer> {
  const key = cellKey(admission, body, rel, into);
  return yield* memoCell(
    admission,
    key,
    () => evaluateBody(admission, body, rel, into, batch),
    batch,
  );
}

/** A cell's memo key: its literal, node and reading, the steps below the literal, and the decision; charged. */
function cellKey(
  admission: Admission,
  body: Body,
  rel: readonly string[],
  into: Key | null,
): string {
  admission.pass.program.work.charge("checks", 1 + body.strip.length + rel.length);
  return `${body.value}\u0001${body.node.id}\u0001${into === null ? "" : String(into)}\u0001${body.strip.join("\u0001")}\u0002${rel.join("\u0001")}`;
}

/**
 * #2289 (R49): one comparison evaluation, lexical to one invocation of `literalElements` and passed down explicitly:
 * each completed cell answer it computed, by its normalised key (`cellKey`, `into` null), so a nest's inner cell is an
 * intermediate result of the enclosing comparison, never a result kept for another query. Never on `Admission`, in a
 * memoised closure or in a proof demand: a solver run entered from it (`drive` resolving a key) evaluates without it and
 * records its own reads. A forget empties it; a stopped answer empties it and ends its use, so no answer made before a
 * stop or a forget is consumed after it. Premise (R52): an outside resolution returns finished inputs.
 */
export interface CellBatch {
  forgets: number;
  stopped: boolean;
  readonly slots: Map<string, CellAnswer>;
}

/** A comparison evaluation, empty, at the solver's current forgets. */
export function cellBatch(admission: Admission): CellBatch {
  return { forgets: admission.pass.solver.forgets, stopped: false, slots: new Map() };
}

/** The batch's slot for a key, where it may be consumed: outside solver runs and decisions, at its own forgets. */
function batchSlot(
  admission: Admission,
  batch: CellBatch | null,
  key: string,
): CellAnswer | undefined {
  const { solver } = admission.pass;
  if (batch === null || batch.stopped || solver.running || admission.deciding > 0) return undefined;
  if (batch.forgets !== solver.forgets) {
    batch.slots.clear();
    batch.forgets = solver.forgets;
  }
  return batch.slots.get(key);
}

/**
 * A memoized cell answer, else the evaluation's: entered only where the evaluation ran outside a solver run, waited on
 * no key, did not stop and saw no forget, so a proof run evaluates afresh and records each read.
 */
function* memoCell(
  admission: Admission,
  key: string,
  evaluate: () => Inheriting<CellAnswer>,
  batch: CellBatch | null,
): Inheriting<CellAnswer> {
  const { solver } = admission.pass;
  if (solver.running) return yield* evaluate();
  const slot = batchSlot(admission, batch, key);
  if (slot !== undefined) return slot;
  const forgets = solver.forgets;
  if (admission.cellMemo === null || admission.cellMemo.forgets !== forgets)
    admission.cellMemo = { forgets, answers: new Map() };
  const memo = admission.cellMemo;
  const known = memo.answers.get(key);
  if (known !== undefined) return known;
  const steps = evaluate();
  let waited = false;
  let step = steps.next();
  while (step.done !== true) {
    if (!isRead(step.value)) waited = true;
    step = steps.next(yield step.value);
  }
  const answer = step.value;
  if (batch !== null && answer.kind === "stopped") {
    batch.stopped = true;
    batch.slots.clear();
  } else if (
    batch !== null &&
    !batch.stopped &&
    batch.forgets === forgets &&
    solver.forgets === forgets &&
    !solver.running &&
    admission.deciding === 0
  )
    batch.slots.set(key, answer);
  if (!waited && answer.kind !== "stopped" && solver.forgets === forgets && !solver.running)
    memo.answers.set(key, answer);
  return answer;
}

function* evaluateBody(
  admission: Admission,
  body: Body,
  rel: readonly string[],
  into: Key | null,
  batch: CellBatch | null,
): Inheriting<CellAnswer> {
  const { program, contract, values } = admission.pass;
  const whole = body.strip.length === 0;
  const none: CellAnswer = { kind: "none", nullable: false, host: false };
  if (whole && rel.length === 0) return none;
  const step = whole ? rel[0]! : null;
  // (a whole body's scopes are its cell steps: a step of one element is that element's own reading, a stop of the view
  // itself, and a step of none, as a list's own `#value`, has no element to describe)
  if (!body.scopes.has(step)) return none;
  const below = whole ? rel.slice(1) : rel;
  // (R55: a pseudo-step, `#value` and `#text` (V30 §19) or any other `#` step, is keyed by no walk: each element is read
  // through its projection up to that step, as the carrier rules read it (`carriedByRead`, `termAt`), and every element
  // of the cell is described, so none is omitted there)
  const selection = below.findIndex((each) => each.startsWith("#"));
  program.work.charge("checks", below.length);
  if (selection >= 0)
    return withCopies(
      admission,
      yield* evaluateSelected(admission, body.scopes.get(step)!, below, selection, into, batch),
      body.copies.get(step),
    );
  const index = yield* indexOf(admission, body);
  const found = new Set<BodyScope>();
  // (`buildIndex` appends to each list in the body's order, so one list's scopes need no sort; a merge of two or more
  // does, and is charged where it sorts: R65, the choice lists' sort per evaluation otherwise grows as m·log m)
  let lists = 0;
  const take = (list: readonly BodyScope[] | undefined): void => {
    if (list === undefined) return;
    lists += 1;
    for (const scope of list) if (scope.step === step) found.add(scope);
  };
  let text = "";
  for (let length = whole ? 1 : 0; length <= rel.length; length += 1) {
    program.work.charge("checks");
    if (length > 0) text = length === 1 ? rel[0]! : stepText(text, rel[length - 1]!);
    take(index.reach.get(text));
    if (length === rel.length) take(index.exact.get(text));
  }
  const scopes = [...found];
  if (lists > 1) {
    scopes.sort((a, b) => a.position - b.position);
    program.work.charge("checks", sortCost(scopes.length));
  }
  const at = restRef(contract, below);
  const descriptors: Descriptor[] = [];
  for (const scope of scopes) {
    program.work.charge("checks");
    const view = scope.view!;
    const answer = yield* scanView(
      admission,
      view,
      at,
      below,
      into,
      () => viewDepths(admission, view),
      0,
      batch,
    );
    if (answer?.stopped === true) return { kind: "stopped" };
    const items = withoutEmpty(
      yield* admission.runRead(() =>
        values.valueItems(scope.value, scope.node, stepsAfter(scope.strip, below)),
      ),
    );
    const descriptor = describe(scope.value, answer, items);
    if (descriptor === null) return { kind: "stopped" };
    descriptors.push(descriptor);
  }
  return withCopies(admission, fitOf(admission, descriptors), body.copies.get(step));
}

/** A conflict's misfits with the copies R37 left out of its body: each misfits as the first it copies does. */
function withCopies(
  admission: Admission,
  answer: CellAnswer,
  copies: ReadonlyMap<PlaceId, PlaceId> | undefined,
): CellAnswer {
  if (answer.kind !== "conflict" || copies === undefined || answer.misfits.size === 0)
    return answer;
  admission.pass.program.work.charge("checks", copies.size);
  const misfits = new Map(answer.misfits);
  for (const [copy, first] of copies) {
    const misfit = answer.misfits.get(first);
    if (misfit !== undefined) misfits.set(copy, misfit);
  }
  return { ...answer, misfits };
}

/**
 * R55: a cell at a path with a pseudo-step (`below[selection]`): each element's descriptor its projected reading's
 * scan, its recipe the element's strip and the path to that step (`expandRead`, the carrier rules), at the rest below.
 */
function* evaluateSelected(
  admission: Admission,
  scopes: readonly BodyScope[],
  below: readonly string[],
  selection: number,
  into: Key | null,
  batch: CellBatch | null,
): Inheriting<CellAnswer> {
  const { program, contract, values } = admission.pass;
  const rest = below.slice(selection + 1);
  const at = restRef(contract, rest);
  const descriptors: Descriptor[] = [];
  for (const scope of scopes) {
    program.work.charge("checks", 1 + selection);
    const projected = yield* expandRead(
      admission,
      scope.value,
      scope.node,
      keptSteps(admission.work, scope.strip, below.slice(0, selection + 1)),
    );
    const view = yield* viewOfRead(admission, projected);
    const answer = yield* scanView(
      admission,
      view,
      at,
      rest,
      into,
      () => viewDepths(admission, view),
      0,
      batch,
    );
    if (answer?.stopped === true) return { kind: "stopped" };
    const items = withoutEmpty(
      yield* admission.runRead(() =>
        values.valueItems(scope.value, scope.node, stepsAfter(scope.strip, below)),
      ),
    );
    const descriptor = describe(scope.value, answer, items);
    if (descriptor === null) return { kind: "stopped" };
    descriptors.push(descriptor);
  }
  return fitOf(admission, descriptors);
}

/** An element's descriptor from its scan's answer and its items at the path; `null` where a stop left it undecided. */
function describe(
  value: PlaceId,
  answer: DeciderAnswer | null,
  items: readonly { readonly tag: ItemTag; readonly reasons: number }[],
): Descriptor | null {
  const nullable = items.some((item) => item.tag === "null");
  if (answer?.term != null) {
    const written = typeTags(answer.term);
    return {
      value,
      tags: written.filter((tag) => tag !== "null"),
      term: answer.term,
      nullable: nullable || written.includes("null"),
      site: answer.site,
      own: answer.own === true,
      host: answer.host === true,
    };
  }
  const tags = answer?.tags ?? [];
  if (
    tags.length === 0 &&
    items.some((item) => item.tag === "unknown" && (item.reasons & REASON.budget) !== 0)
  )
    return null;
  // (an inferred element's kinds by family: a whole number beside a number in one value is a number)
  const kinds = tags.includes("number") ? tags.filter((tag) => tag !== "integer") : tags;
  const host =
    kinds.length === 0 &&
    items.some((item) => item.tag === "unknown" && (item.reasons & REASON.external) !== 0);
  return { value, tags: kinds, term: null, nullable, site: answer?.site ?? null, own: false, host };
}

/** A view's deepest path per map, once (`scanView`'s loops). */
export function viewDepths(
  admission: Admission,
  view: View,
): { readonly written: number; readonly values: number; readonly literals: number } {
  if (view.depths !== null) return view.depths;
  const deepest = (map: ReadonlyMap<string, unknown>): number => {
    let depth = 0;
    for (const text of map.keys()) {
      admission.pass.program.work.charge("checks");
      depth = Math.max(depth, textDepth(text));
    }
    return depth;
  };
  view.depths = {
    written: deepest(view.written),
    values: deepest(view.values),
    literals: deepest(view.literals),
  };
  return view.depths;
}

/** A literal's cell asked by its value (`literalElements`): its whole body's, at `step` and the rest below it. */
export function* cellOfLiteral(
  admission: Admission,
  literal: PlaceId,
  node: FlowNode,
  step: string,
  rest: readonly string[],
  batch: CellBatch | null = null,
): Inheriting<CellAnswer> {
  const body = yield* bodyOfRead(admission, literal, node, []);
  return yield* cellOfBody(admission, body, joinSteps([step], rest), null, batch);
}

/** Whether a kind fits a set of kinds: one of them, a whole number where they hold a number, any where unknown. */
function fitsIn(tag: ItemTag, set: readonly ItemTag[]): boolean {
  return (
    tag === "unknown" ||
    set.includes(tag) ||
    set.includes("unknown") ||
    (tag === "integer" && set.includes("number"))
  );
}

/**
 * Rule 3: whether kinds do not fit the earliest element's type: a declared one's by its kinds (a whole number fits a
 * number, a fraction no whole number), an inferred one's by their family, as a later store widens it (rule 1.2).
 */
export function misfits(earliest: Descriptor, tags: readonly ItemTag[]): boolean {
  const declared = earliest.term !== null;
  return tags.some(
    (tag) =>
      tag !== "null" &&
      !fitsIn(tag, earliest.tags) &&
      (declared || !(tag === "number" && earliest.tags.includes("integer"))),
  );
}

function sameKinds(a: readonly ItemTag[], b: readonly ItemTag[]): boolean {
  return a.length === b.length && a.every((tag) => b.includes(tag));
}

/**
 * B1 over the descriptors of one cell at one path, order-free but for the conflict's earliest and the sites: rule 1
 * (whole numbers and numbers alone are numbers where any is one), rule 2 (the kinds every element fits), rule 3
 * (none), rule 4 (`null` makes optional), rule 5 (strict where a declared element has exactly the kinds). Over the
 * distinct kind sets, so its cost is theirs, not the elements' square.
 */
export function fitOf(admission: Admission, descriptors: readonly Descriptor[]): CellAnswer {
  const work = admission.pass.program.work;
  const nullable = descriptors.some((x) => x.nullable);
  const host = descriptors.some((x) => x.host);
  const deciding = descriptors.filter((x) => x.tags.length > 0);
  if (deciding.length === 0) return { kind: "none", nullable, host };
  const sets = new Map<string, readonly ItemTag[]>();
  for (const x of deciding) {
    const name = [...x.tags].sort().join(",");
    if (!sets.has(name)) sets.set(name, x.tags);
  }
  work.charge("checks", deciding.length);
  const distinct = [...sets.values()];
  let kinds: readonly ItemTag[] | null = null;
  if (distinct.every((set) => set.length === 1 && (set[0] === "integer" || set[0] === "number")))
    kinds = distinct.some((set) => set[0] === "number") ? ["number"] : ["integer"];
  else
    for (const candidate of distinct) {
      work.charge("checks", distinct.length);
      if (distinct.every((set) => set.every((tag) => fitsIn(tag, candidate)))) {
        kinds = candidate;
        break;
      }
    }
  if (kinds === null) {
    const earliest = deciding[0]!;
    const misfit = new Map<PlaceId, Descriptor>();
    for (const x of deciding.slice(1)) if (misfits(earliest, x.tags)) misfit.set(x.value, x);
    return { kind: "conflict", earliest, misfits: misfit, nullable, host };
  }
  const declared = deciding.find((x) => x.term !== null && sameKinds(x.tags, kinds));
  if (declared !== undefined) {
    // (rule 4: a declared element's `null` stays in the written type the place is published with)
    const declaredNull = deciding.some((x) => x.term !== null && typeTags(x.term).includes("null"));
    const withNull: TypeTerm =
      declaredNull && !typeTags(declared.term!).includes("null")
        ? { kind: "union", members: [declared.term!, NULL] }
        : declared.term!;
    return {
      kind: "fit",
      tags: kinds,
      strict: true,
      term: withNull,
      nullable,
      site: declared.site,
      own: declared.own,
      host,
    };
  }
  const site = deciding.find((x) => sameKinds(x.tags, kinds))?.site ?? deciding[0]!.site;
  return { kind: "fit", tags: kinds, strict: false, term: null, nullable, site, own: false, host };
}

const NULL: TypeTerm = { kind: "atom", name: "null" };

/** A non-scalar kind: a term built of kinds alone cannot stand for it (`completeTerm` keeps the written part). */
const SHAPED: ReadonlySet<ItemTag> = new Set(["list", "set", "dict", "object", "unknown", "empty"]);

/**
 * R3-5: a strict answer's complete term, built down its deciding term: each collection's element and each object's
 * property the cell's own answer one step below (a strict one's complete term, an inferred one's kinds, a conflict's
 * earliest element's type), the written part kept where none decides there; `null` where a stop left any of them
 * undecided, so a strict answer is never published with an old leaf below a stopped one.
 */
export function* completeTerm(
  admission: Admission,
  source: CellSource,
  term: TypeTerm,
): Inheriting<TypeTerm | null> {
  const below = function* (at: TypeTerm, step: string): Inheriting<TypeTerm | null> {
    admission.pass.program.work.charge("checks");
    const rel = [...source.rel, step];
    const answer = yield* cellOfBody(admission, source.body, rel, source.into);
    switch (answer.kind) {
      case "stopped":
        return null;
      case "none":
        return at;
      case "fit":
        if (answer.strict) return yield* completeTerm(admission, { ...source, rel }, answer.term!);
        return termOfTags(answer.tags, answer.nullable) ?? at;
      case "conflict":
        return answer.earliest.term ?? termOfTags(answer.earliest.tags, false) ?? at;
    }
  };
  switch (term.kind) {
    case "list":
    case "set":
    case "dict": {
      const element = yield* below(term.element, "element");
      return element === null ? null : element === term.element ? term : { ...term, element };
    }
    case "object": {
      if (term.properties === null) return term;
      const properties: { readonly name: string; readonly type: TypeTerm }[] = [];
      for (const property of term.properties) {
        const type = yield* below(property.type, property.name);
        if (type === null) return null;
        properties.push(type === property.type ? property : { name: property.name, type });
      }
      return { kind: "object", properties };
    }
    case "union": {
      const members: TypeTerm[] = [];
      for (const member of term.members) {
        const made = yield* completeTerm(admission, source, member);
        if (made === null) return null;
        members.push(made);
      }
      return { kind: "union", members };
    }
    default:
      return term;
  }
}

/** A term of scalar kinds, `null` added where `nullable`; `null` where a kind needs a shape. */
function termOfTags(tags: readonly ItemTag[], nullable: boolean): TypeTerm | null {
  if (tags.some((tag) => SHAPED.has(tag))) return null;
  const members: TypeTerm[] = tags.map((tag) => ({ kind: "atom", name: tag as never }));
  if (nullable) members.push(NULL);
  return members.length === 1 ? members[0]! : { kind: "union", members };
}
