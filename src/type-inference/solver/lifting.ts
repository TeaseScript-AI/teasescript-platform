import { PropertyTable, UNKNOWN_TYPE, type StaticType } from "../../static-types.js";
import type { ValueKind } from "../../value-kinds.js";
import { memberOf } from "../adapters/members.js";
import type {
  OperandPath,
  OperandRef,
  OperandView,
  OperationInputs,
  OperationRelation,
  OperationResult,
} from "../adapters/relation.js";
import type { ContractRef, NamedPlace, PlaceId, ProjectionStep, SyntaxEvidence } from "../graph.js";
import {
  positionAt,
  type CellId,
  type Cells,
  type Constructor,
  type Item,
  type Position,
  type Provenance,
} from "./cells.js";
import type { TypeId, TypeNode } from "./types.js";

// The lifting of a relation's answers into cells (O4 stage 3a, work note §3.5; the executable reference model is the
// contract). An operand's alternatives are one per flat item and one per combination of the parts' alternatives of a
// structural item, so they only grow. The relation is asked when every strict operand has evidence; a lazy operand
// (a `default:`, the right side of `and`, `or`, `otherwise`) is always also asked unevaluated. The witness
// combinations are asked with closed views; the dynamic view is asked once per provenance of an operand that has
// one; each possibility is asked as a closed alternative. An answer is read per the carrier: `type` the
// combination's result (a member with the operation's site as identity when a chosen alternative is a member), an
// `alternatives` answer with two value-bearing results a permitted union the contract defines, a projection the
// chosen alternative's part along the graph's path with its own tag, a join the collection built over the projected
// parts into the result's derived part cell, `byReceiver` the case of the chosen receiver kind, `possible`
// possibilities, `dynamic` a dynamic item, `invalid` an invalid combination. Property reads on a receiver that is not
// an object go through the member rules composed over the receiver's kinds, as `methodRelation` composes methods.

const DEPTH = 3;
const RECEIVER: OperandRef = { receiver: true };

export interface Alternative {
  /** The closed type, materialized over the chosen parts. */
  readonly type: TypeId;
  readonly tag: "w" | "m" | "p";
  readonly group: string | undefined;
  readonly why: Provenance | undefined;
  /** The chosen part alternatives of a structural item, for projections; `null` for a flat type. */
  readonly choice: Choice | null;
}

export type Choice =
  | { readonly element: Alternative; readonly cell: CellId; readonly props?: undefined }
  | {
      readonly props: ReadonlyMap<string, Alternative>;
      readonly cells: ReadonlyMap<string, CellId>;
      readonly element?: undefined;
    };

/** A dynamic item met along a projection of the dynamic view. */
interface DynamicMark {
  readonly tag: "d";
  readonly why: Provenance;
}

const byName = ([a]: readonly [string, unknown], [b]: readonly [string, unknown]): number =>
  a < b ? -1 : a > b ? 1 : 0;

/** The receiver kind a node names for `byReceiver`: a scalar's name, a collection's or object's kind. */
function kindOf(node: TypeNode): string {
  switch (node.kind) {
    case "atom":
    case "restricted":
      return node.name;
    default:
      return node.kind;
  }
}

/** The alternatives of a cell: what a relation is asked with, including the possibilities (`p`). */
function alternatives(cells: Cells, cell: CellId, depth = 0): readonly Alternative[] {
  const out = new Map<string, Alternative>();
  for (const item of cells.items(cell)) {
    if (item.tag === "d" || item.tag === "e") continue;
    for (const alternative of itemAlternatives(cells, item, depth)) {
      const key = `${alternative.tag}|${alternative.type}|${alternative.group ?? ""}|${alternative.why ?? ""}`;
      if (!out.has(key)) out.set(key, alternative);
    }
  }
  return [...out.values()];
}

export function itemAlternatives(cells: Cells, item: Item, depth: number): readonly Alternative[] {
  const tag: Alternative["tag"] =
    item.tag === "n"
      ? "w"
      : item.tag === "b"
        ? "m"
        : item.tag === "p"
          ? "p"
          : item.tag === "m"
            ? "m"
            : "w";
  if (item.type !== undefined)
    return [{ type: item.type, tag, group: item.group, why: item.why, choice: null }];
  if (item.parts === undefined || item.ctor === undefined || depth > DEPTH) return [];
  const table = cells.table;
  const compose = (
    type: StaticType,
    chosen: readonly Alternative[],
    choice: Choice,
  ): Alternative => {
    const possible = chosen.find((a) => a.tag === "p");
    const member = chosen.find((a) => a.tag === "m");
    const t: Alternative["tag"] =
      tag === "p" || possible !== undefined ? "p" : tag === "m" || member !== undefined ? "m" : "w";
    return {
      type: table.intern(type),
      tag: t,
      group: t === "m" ? (tag === "m" ? item.group : member?.group) : undefined,
      why: t === "p" ? (item.why ?? possible?.why) : undefined,
      choice,
    };
  };
  if (item.parts.props !== undefined) {
    const entries = [...item.parts.props].sort(byName);
    let combos: (readonly [string, Alternative])[][] = [[]];
    for (const [name, part] of entries) {
      const parts = partAlternatives(cells, part, depth + 1);
      combos = combos.flatMap((combo) => parts.map((a) => [...combo, [name, a] as const]));
    }
    const propCells: ReadonlyMap<string, CellId> = item.parts.props;
    return combos.map((combo) =>
      compose(
        {
          kind: "object",
          properties: new PropertyTable(combo.map(([name, a]) => [name, table.toStatic(a.type)])),
        },
        combo.map(([, a]) => a),
        { props: new Map(combo), cells: propCells },
      ),
    );
  }
  const element = item.parts.element;
  const ctor: Exclude<Constructor, "object"> = item.ctor === "object" ? "list" : item.ctor;
  return partAlternatives(cells, element, depth + 1).map((a) =>
    compose({ kind: ctor, element: table.toStatic(a.type) }, [a], { element: a, cell: element }),
  );
}

/**
 * The alternatives of a part: its own, plus `never` for a part empty by construction and the legacy's `unknown` for
 * a part with dynamic evidence, both permanent; a part without evidence yet contributes nothing.
 */
function partAlternatives(cells: Cells, part: CellId, depth: number): readonly Alternative[] {
  const out = [...alternatives(cells, part, depth)];
  const items = cells.items(part);
  if (items.some((it) => it.tag === "e"))
    out.push({
      type: cells.table.intern({ kind: "never" }),
      tag: "w",
      group: undefined,
      why: undefined,
      choice: null,
    });
  if (items.some((it) => it.tag === "d" || it.tag === "p"))
    out.push({
      type: cells.table.intern(UNKNOWN_TYPE),
      tag: "w",
      group: undefined,
      why: undefined,
      choice: null,
    });
  return out;
}

function closedAlternatives(cells: Cells, cell: CellId): readonly Alternative[] {
  return alternatives(cells, cell).filter((a) => a.tag !== "p");
}

function possibilities(cells: Cells, cell: CellId): readonly Alternative[] {
  return alternatives(cells, cell).filter((a) => a.tag === "p");
}

/** The provenances of a cell's own dynamic items and possibilities, sorted; a part's provenance stays in the part. */
function provenances(cells: Cells, cell: CellId): readonly Provenance[] {
  const out = new Set<Provenance>();
  for (const item of cells.items(cell))
    if ((item.tag === "d" || item.tag === "p") && item.why !== undefined) out.add(item.why);
  return [...out].sort();
}

/**
 * One step of a graph path from an alternative: the chosen part (with the part cell's dynamic items when the walk is
 * the dynamic view's), or the type's part for an alternative without a choice; a dict's iteration gives its keys.
 */
function stepOf(
  cells: Cells,
  a: Alternative | DynamicMark,
  step: ProjectionStep,
  withDynamic: boolean,
): readonly (Alternative | DynamicMark)[] {
  if (a.tag === "d") return [a];
  const table = cells.table;
  const node = table.node(a.type);
  const text = (): Alternative => ({
    type: table.intern({ kind: "scalar", name: "string" }),
    tag: a.tag === "p" ? "p" : "w",
    group: undefined,
    why: a.why,
    choice: null,
  });
  if (a.choice !== null) {
    const marks = (cell: CellId): DynamicMark[] =>
      withDynamic
        ? cells
            .items(cell)
            .filter((it) => it.tag === "d" && it.why !== undefined)
            .map((it) => ({ tag: "d", why: it.why! }))
        : [];
    if (a.choice.props !== undefined) {
      if (typeof step !== "object") return [];
      const part = a.choice.props.get(step.property);
      return part === undefined ? [] : [part, ...marks(a.choice.cells.get(step.property)!)];
    }
    if (typeof step === "object") return [];
    if (node.kind === "dict" && step === "iteration") return [text()];
    return [a.choice.element, ...marks(a.choice.cell)];
  }
  if (typeof step === "object") {
    if (node.kind !== "object" || node.properties === null) return [];
    const property = node.properties.find((p) => p.name === step.property);
    return property === undefined ? [] : [{ ...a, type: property.type, choice: null }];
  }
  if (node.kind === "list" || node.kind === "set" || node.kind === "dict")
    return node.kind === "dict" && step === "iteration"
      ? [text()]
      : [{ ...a, type: node.element, choice: null }];
  return [];
}

/** An operation as the lifting sees it: the graph's `operation`, or a property read routed through the member rules. */
export interface Operation {
  readonly contract: ContractRef;
  readonly receiver: PlaceId | null;
  readonly arguments: readonly PlaceId[];
  readonly named: readonly NamedPlace[];
  readonly result: CellId;
  readonly site: number;
  readonly evidence: SyntaxEvidence | undefined;
}

export interface LiftContext {
  readonly cells: Cells;
  /** The non-working alternatives of conflicting cells (`<cell>:<type>`), set by interpretation; `null` while solving. */
  readonly nonWorking: ReadonlySet<string> | null;
  /** Counts every ask of a relation, for measurement. */
  asks: number;
}

/** The counted combinations of one operation: cascades are not counted at all. */
export interface Tally {
  readonly asked: number;
  readonly invalid: number;
}

type Pick =
  | {
      readonly kind: "closed" | "possible";
      readonly alt: Alternative;
      readonly view: OperandView;
      readonly tag: Alternative["tag"];
      readonly why: Provenance | undefined;
    }
  | {
      readonly kind: "bottom";
      readonly view: OperandView;
      readonly tag: "w";
      readonly why: undefined;
    }
  | {
      readonly kind: "dynamic";
      readonly view: OperandView;
      readonly tag: "d";
      readonly why: Provenance;
    };

interface Operand {
  readonly ref: OperandRef;
  readonly cell: CellId;
  readonly lazy: boolean;
}

/** A contribution read from an answer, before it enters the result cell. */
type Outcome =
  | {
      readonly tag: "w" | "m" | "p";
      readonly type: TypeId;
      readonly ctor?: undefined;
      readonly group: string | undefined;
      readonly why: Provenance | undefined;
    }
  | { readonly tag: "d"; readonly why: Provenance; readonly ctor?: undefined }
  | {
      readonly tag: "w" | "m" | "p";
      readonly ctor: Exclude<Constructor, "object">;
      readonly elements: readonly Outcome[];
      readonly group: string | undefined;
      readonly why: Provenance | undefined;
    };

interface Reading {
  readonly base: "w" | "m" | "p";
  readonly site: string;
  readonly why: Provenance | null;
  readonly mode: "closed" | "dynamic" | "possible";
}

const BOTTOM_VIEW: OperandView = { alternatives: null, dynamic: null, known: undefined };

const sameRef = (a: OperandRef, b: OperandRef): boolean =>
  "receiver" in a
    ? "receiver" in b
    : "argument" in a
      ? "argument" in b && a.argument === b.argument
      : "named" in b && a.named === b.named;

/**
 * Asks the relation for one operation over the cells' current alternatives and adds every answer to the result cell.
 * Returns whether the result changed and the tally of counted combinations (`null` when the relation was not asked).
 */
export function lift(
  context: LiftContext,
  operation: Operation,
  relation: OperationRelation | undefined,
): { readonly changed: boolean; readonly tally: Tally | null } {
  const { cells } = context;
  const table = cells.table;
  const pos = positionAt(operation.site);
  if (relation === undefined)
    return {
      changed: cells.add(operation.result, { tag: "d", why: "unknown callee", pos }),
      tally: null,
    };
  const operands: Operand[] = [];
  if (operation.receiver !== null)
    operands.push({ ref: RECEIVER, cell: operation.receiver, lazy: false });
  operation.arguments.forEach((cell, index) =>
    operands.push({ ref: { argument: index }, cell, lazy: false }),
  );
  for (const named of operation.named)
    operands.push({
      ref: { named: named.name },
      cell: named.value,
      lazy: named.name === "default",
    });
  if (operation.contract.family === "logic" && operands[1] !== undefined)
    operands[1] = { ...operands[1], lazy: true };
  // a strict operand without evidence: never; the relation is not asked
  for (const operand of operands)
    if (!operand.lazy && !cells.has(operand.cell)) return { changed: false, tally: null };
  const site = `op@${operation.site}`;
  const views = operands.map((operand) => ({
    alts: closedAlternatives(cells, operand.cell),
    possible: possibilities(cells, operand.cell),
    whys: provenances(cells, operand.cell),
    lazy: operand.lazy,
  }));
  const closed = (alt: Alternative): Pick => ({
    kind: alt.tag === "p" ? "possible" : "closed",
    alt,
    view: { alternatives: [table.toStatic(alt.type)], dynamic: null, known: undefined },
    tag: alt.tag,
    why: alt.why,
  });
  const bottom: Pick = { kind: "bottom", view: BOTTOM_VIEW, tag: "w", why: undefined };
  // a lazy operand is always also asked unevaluated; an operand without closed alternatives blocks the ask unless lazy
  const withBottom = (view: (typeof views)[number], picks: Pick[]): Pick[] | null => {
    if (view.lazy) picks.push(bottom);
    return picks.length === 0 ? null : picks;
  };
  const dynamic = (view: (typeof views)[number]): Pick[] => {
    const all = [...view.alts, ...view.possible].map((a) => table.toStatic(a.type));
    return view.whys.map((why) => ({
      kind: "dynamic",
      view: {
        alternatives: all.length === 0 ? null : all,
        dynamic: why === "unknown" ? "unknown callee" : why,
        known: undefined,
      },
      tag: "d",
      why,
    }));
  };
  const product = (lists: readonly (readonly Pick[])[]): Pick[][] =>
    lists.reduce<Pick[][]>(
      (acc, list) => acc.flatMap((combo) => list.map((pick) => [...combo, pick])),
      [[]],
    );
  let changed = false;
  let asked = 0;
  let invalid = 0;
  const ask = (combo: readonly Pick[], mode: Reading["mode"]): void => {
    const inputs = inputsOf(cells, operands, combo, operation.evidence);
    const cascade =
      context.nonWorking !== null &&
      combo.some(
        (pick, index) =>
          pick.kind === "closed" &&
          context.nonWorking!.has(`${operands[index]!.cell}:${pick.alt.type}`),
      );
    context.asks += 1;
    if (!cascade) asked += 1;
    const base: Reading["base"] =
      mode === "possible" ? "p" : combo.some((pick) => pick.tag === "m") ? "m" : "w";
    const why =
      mode === "closed"
        ? null
        : (combo.find((pick) => pick.kind === "dynamic" || pick.kind === "possible")?.why ?? null);
    const reading = readAnswer(cells, relation.result(inputs), combo, operands, {
      base,
      site,
      why,
      mode,
    });
    if (reading.invalid && !cascade) invalid += 1;
    for (const outcome of reading.outcomes)
      if (emit(cells, operation.result, outcome, pos)) changed = true;
  };
  const closedLists = views.map((view) => withBottom(view, view.alts.map(closed)));
  if (closedLists.every((list) => list !== null))
    for (const combo of product(closedLists.map((list) => list!))) ask(combo, "closed");
  const held = views
    .map((view, index) => (view.whys.length > 0 ? index : -1))
    .filter((index) => index >= 0);
  if (held.length > 0) {
    const lists = views.map((view, index) =>
      held.includes(index) ? dynamic(view) : withBottom(view, view.alts.map(closed)),
    );
    if (lists.every((list) => list !== null))
      for (const combo of product(lists.map((list) => list!))) ask(combo, "dynamic");
  }
  views.forEach((heldView, heldIndex) => {
    if (heldView.possible.length === 0) return;
    const lists = views.map((view, index) =>
      index === heldIndex
        ? view.possible.map(closed)
        : withBottom(view, (view.alts.length > 0 ? view.alts : view.possible).map(closed)),
    );
    if (lists.every((list) => list !== null))
      for (const combo of product(lists.map((list) => list!))) ask(combo, "possible");
  });
  return { changed, tally: { asked, invalid } };
}

function inputsOf(
  cells: Cells,
  operands: readonly Operand[],
  combo: readonly Pick[],
  evidence: SyntaxEvidence | undefined,
): OperationInputs {
  let receiver: OperandView | null = null;
  const args: OperandView[] = [];
  const named = new Map<string, OperandView>();
  operands.forEach((operand, index) => {
    const view = combo[index]!.view;
    if ("receiver" in operand.ref) receiver = view;
    else if ("argument" in operand.ref) args[operand.ref.argument] = view;
    else named.set(operand.ref.named, view);
  });
  const table = cells.table;
  return {
    receiver,
    arguments: args,
    named,
    evidence,
    view(place) {
      const alts = closedAlternatives(cells, place).map((a) => table.toStatic(a.type));
      const whys = provenances(cells, place);
      const why = whys[0];
      return {
        alternatives: alts.length === 0 ? null : alts,
        dynamic: why === undefined ? null : why === "unknown" ? "unknown callee" : why,
        known: undefined,
      };
    },
  };
}

/** Reads an answer for one combination into outcomes; see the module comment for the tag of each answer kind. */
function readAnswer(
  cells: Cells,
  answer: OperationResult,
  combo: readonly Pick[],
  operands: readonly Operand[],
  reading: Reading,
): { readonly outcomes: readonly Outcome[]; readonly invalid: boolean } {
  const table = cells.table;
  const outcomes: Outcome[] = [];
  let invalid = false;
  const own = (member: boolean, possible: boolean): "w" | "m" | "p" =>
    possible ? "p" : member ? "m" : reading.mode === "dynamic" ? "w" : reading.base;
  const walk = (a: OperationResult, member: boolean, possible: boolean): void => {
    switch (a.kind) {
      case "type": {
        const tag = own(member, possible);
        outcomes.push({
          tag,
          type: table.intern(a.type),
          group: tag === "m" ? reading.site : undefined,
          why: tag === "p" ? (reading.why ?? undefined) : undefined,
        });
        break;
      }
      case "possible":
        for (const type of a.types)
          outcomes.push({ tag: "p", type: table.intern(type), group: undefined, why: a.why });
        break;
      case "dynamic":
        outcomes.push({ tag: "d", why: a.why });
        break;
      case "invalid":
        invalid = true;
        break;
      case "unconstrained":
        break;
      case "projection":
        outcomes.push(...project(cells, a.source, combo, operands, reading, member, possible));
        break;
      case "join": {
        const tag = own(member, possible);
        outcomes.push({
          tag,
          ctor: a.constructor,
          elements: a.parts.flatMap((part) =>
            project(cells, part, combo, operands, reading, member, possible),
          ),
          group: tag === "m" ? reading.site : undefined,
          why: tag === "p" ? (reading.why ?? undefined) : undefined,
        });
        break;
      }
      case "alternatives": {
        const bearing = a.results.filter(
          (r) => r.kind !== "dynamic" && r.kind !== "unconstrained" && r.kind !== "invalid",
        ).length;
        for (const result of a.results) walk(result, member || bearing >= 2, possible);
        break;
      }
      case "byReceiver": {
        const index = operands.findIndex((operand) => "receiver" in operand.ref);
        if (index < 0) break;
        const pick = combo[index]!;
        if (pick.kind === "bottom") break;
        if (pick.kind === "dynamic") {
          const kinds = (pick.view.alternatives ?? []).map((type) =>
            kindOf(table.node(table.intern(type))),
          );
          const cases = a.cases.filter((c) => kinds.length === 0 || kinds.includes(c.receiver));
          for (const c of cases) walk(c.result, member, possible || cases.length >= 2);
          break;
        }
        const kind = kindOf(table.node(pick.alt.type));
        for (const c of a.cases) if (c.receiver === kind) walk(c.result, member, possible);
        break;
      }
    }
  };
  walk(answer, false, reading.mode === "possible");
  return { outcomes, invalid };
}

/**
 * A projection: through the combination's chosen alternative of the operand (nothing for an unevaluated lazy
 * operand); for the dynamic view, through every alternative and dynamic item of the operand's cell.
 */
function project(
  cells: Cells,
  source: OperandPath,
  combo: readonly Pick[],
  operands: readonly Operand[],
  reading: Reading,
  member: boolean,
  possible: boolean,
): readonly Outcome[] {
  const index = operands.findIndex((operand) => sameRef(operand.ref, source.of));
  if (index < 0) return [];
  const pick = combo[index]!;
  if (pick.kind === "bottom") return [];
  const dynamicWalk = pick.kind === "dynamic";
  let found: readonly (Alternative | DynamicMark)[] = dynamicWalk
    ? [
        ...alternatives(cells, operands[index]!.cell),
        ...cells
          .items(operands[index]!.cell)
          .filter((it) => it.tag === "d" && it.why !== undefined)
          .map((it): DynamicMark => ({ tag: "d", why: it.why! })),
      ]
    : [pick.alt];
  for (const step of source.path) found = found.flatMap((a) => stepOf(cells, a, step, dynamicWalk));
  return found.map((a): Outcome => {
    if (a.tag === "d") return { tag: "d", why: a.why };
    const tag: "w" | "m" | "p" = a.tag === "p" || possible ? "p" : member ? "m" : a.tag;
    return {
      tag,
      type: a.type,
      group: tag !== "m" ? undefined : member ? reading.site : a.group,
      why: tag !== "p" ? undefined : a.tag === "p" ? a.why : (reading.why ?? undefined),
    };
  });
}

/** Adds an outcome to the result cell; a structural outcome's elements go to the result's derived part cell. */
function emit(cells: Cells, result: CellId, outcome: Outcome, pos: Position): boolean {
  if (outcome.tag === "d") return cells.add(result, { tag: "d", why: outcome.why, pos });
  if (outcome.ctor !== undefined) {
    const element = cells.derived(result, "element");
    let changed = false;
    for (const part of outcome.elements) if (emit(cells, element, part, pos)) changed = true;
    if (
      cells.add(result, {
        tag: outcome.tag,
        ctor: outcome.ctor,
        parts: { element },
        group: outcome.group,
        why: outcome.why,
        pos,
      })
    )
      changed = true;
    return changed;
  }
  return cells.add(result, {
    tag: outcome.tag,
    type: outcome.type,
    group: outcome.group,
    why: outcome.why,
    pos,
  });
}

const MEMBER_RELATIONS = new Map<string, OperationRelation>();

/**
 * The relation of a property read on a receiver (`xs.length`, `xs.first`, `t.length`): the member rules decide it per
 * receiver kind, composed over a view's kinds as `methodRelation` composes methods; a held part is read as a
 * projection of the receiver, a kind without the member is invalid unless the receiver may hold data the compiler
 * cannot know, and a dynamic receiver adds its provenance. An object's own property cell is read in place beside it.
 */
export function memberRelation(name: string): OperationRelation {
  let relation = MEMBER_RELATIONS.get(name);
  if (relation === undefined) {
    relation = {
      contract: { family: "member", name },
      result(inputs: OperationInputs): OperationResult {
        const receiver = inputs.receiver;
        if (receiver === null) return { kind: "invalid" };
        if (receiver.alternatives === null && receiver.dynamic === null)
          return { kind: "unconstrained" };
        const kinds = [...new Set((receiver.alternatives ?? []).map(staticKind))];
        if (kinds.length === 0) return { kind: "dynamic", why: receiver.dynamic! };
        const cases = kinds.map((kind) => {
          const answer = kind === null ? undefined : memberOf(kind, name, receiver);
          const result: OperationResult | undefined =
            answer === undefined
              ? undefined
              : answer.kind === "held"
                ? { kind: "projection", source: { of: RECEIVER, path: [answer.step] } }
                : answer;
          return { receiver: kind, result };
        });
        if (receiver.dynamic === null && cases.some((c) => c.result === undefined))
          return { kind: "invalid" };
        const known = cases.flatMap((c) =>
          c.result === undefined || c.receiver === null
            ? []
            : [{ receiver: c.receiver, result: c.result }],
        );
        const composed: OperationResult =
          known.length === 1 ? known[0]!.result : { kind: "byReceiver", cases: known };
        return receiver.dynamic === null
          ? composed
          : {
              kind: "alternatives",
              results: [composed, { kind: "dynamic", why: receiver.dynamic }],
            };
      },
    };
    MEMBER_RELATIONS.set(name, relation);
  }
  return relation;
}

/** The value kind of a closed static type, or `null` for null, never and unknown, which have no members. */
function staticKind(type: StaticType): ValueKind | null {
  switch (type.kind) {
    case "scalar":
      return type.name;
    case "list":
    case "set":
    case "dict":
    case "object":
      return type.kind;
    default:
      return null;
  }
}
