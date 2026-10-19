import { NULL_TYPE, PropertyTable, UNKNOWN_TYPE, type StaticType } from "../../static-types.js";
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
import { NO_PARAMETERS } from "../adapters/relation.js";
import { BUDGET_WHY, cutCell, isCutCell, overBudget, type BudgetCut } from "./budget.js";
import type { TypeId, TypeNode } from "./types.js";

// The lifting of a relation's answers into cells (O4 stage 3a, work note §3.5; the executable reference model is the
// contract). An operand's alternatives are one per flat item, one per alternative of the element of a collection item
// (nesting one part at a time: a part empty by construction is `never`, a part with dynamic evidence is also the
// legacy's `unknown`, a part already on the path, a structural cycle, is `unknown`, all permanently; a part without
// evidence contributes nothing yet), and **one** per object item: its shape, every slot with the placeholder `never`,
// which no relation reads (a property's type is read as a leaf, O1). The sets only grow. The relation is asked when
// every strict operand has evidence, over one product of choices: each operand chooses a closed alternative, a
// possibility, a dynamic view (one per provenance: its alternatives and possibilities beside the provenance), or, when
// lazy (a `default:`, the right side of `and` and `or`), nothing. The relation's **plan** (P1) says how its inputs are
// read: `collected` positional arguments are summed (one aggregate pick each, every alternative at once, because the
// result unions them: a choice's options), a `fold` relation (`min`, `max` of values) folds its arguments by its
// binary law, one ask per state and choice, and the places the evidence names are declared inputs: the schedule
// depends on them, a relation reads them as a chosen dimension (`view`) or, where it sums them, as an aggregate
// (`collect`), and a read of an undeclared place is a defect. Beyond the operands, the dimensions a relation reads
// are selected lazily: a leaf of an operand along a path (`inputs.leaf`), a place the evidence names (`inputs.view`),
// a structural step inside a path (the chosen item), and the presence of a property a projection reads (present or
// absent where its slot is empty by construction beside evidence); a read of a dimension not yet selected records it,
// the ask is discarded and repeated once per choice of that dimension. The lists only grow and every choice is an
// alternative that never changes, so no combination asked earlier is lost. A combination with a possibility is asked
// for possibilities, one with a dynamic view for the dynamic reading (an unconditional `type` answer is a witness),
// the rest for witnesses and members. An answer is read per the carrier: `type` the combination's result (a member
// with the operation's site as identity when a chosen alternative is a member), an `alternatives` answer with two
// value-bearing results a permitted union the contract defines, a projection the chosen alternative's part along the
// graph's path with its own tag and, for a structural part, the item itself (parts shared), a join the collection
// built over the projected parts into the result's derived part cell, a `structure` the object or dict built part by
// part into the result's part cells (each part asked on its own), `byReceiver` the case of the chosen receiver kind
// (under a dynamic receiver every applicable case's answers are possibilities), `possible` possibilities, `dynamic` a
// dynamic item, `invalid` an invalid combination. Property reads on a receiver go through the member rules composed
// over the receiver's kinds.

const RECEIVER: OperandRef = { receiver: true };

export interface Alternative {
  /** The closed type, materialized over the chosen parts. */
  readonly type: TypeId;
  readonly tag: "w" | "m" | "p";
  readonly group: string | undefined;
  readonly why: Provenance | undefined;
  /** Every cell the alternative was read from (two items alike give one alternative), the sources of a projection. */
  readonly cells: readonly CellId[];
  /** The structural items it materializes, carried as themselves by a projection; none for a flat type or a synthetic part. */
  readonly items: readonly Item[];
  /** The chosen part of a structural item, for projections; `null` for a flat type. */
  readonly choice: Choice | null;
  /** The cases of the structural items it materializes (I1); none for a flat type or a synthetic part. */
  readonly cases: readonly string[];
}

/**
 * The chosen part of a structural alternative: a collection's one chosen element alternative with every element cell
 * the merged items hold it in (a dynamic walk reads each); an object's part cells per property, over all the merged
 * items of its shape (a property is read from them on demand, O1).
 */
export type Choice =
  | { readonly element: Alternative; readonly cells: readonly CellId[]; readonly props?: undefined }
  | {
      readonly props: ReadonlyMap<string, readonly CellId[]>;
      readonly cells: ReadonlyMap<string, readonly CellId[]>;
      readonly element?: undefined;
    };

const unionOf = (left: readonly CellId[], right: readonly CellId[]): readonly CellId[] =>
  [...new Set([...left, ...right])].sort((a, b) => a - b);

/**
 * The roles of an alternative and of a collection's chosen element (tag, identity, provenance): two alternatives of
 * one type are one only when the chosen part has the same role, else a projection through the merged choice would
 * take the role of whichever was enumerated first (r11-B1). An object alternative is its shape, so its role is its own:
 * its properties are read as leaves, never chosen.
 */
function roleOf(a: Alternative): string {
  // ... and by its cases (I1): two alternatives of one type and role but of different cases are two, so an
  // alternative's cases never change once it exists (a merged case set would be support, growing with arrival)
  const own = `${a.tag}|${a.group ?? ""}|${a.why ?? ""}|${a.cases.join("+")}`;
  if (a.choice === null || a.choice.element === undefined) return own;
  return `${own}[${roleOf(a.choice.element)}]`;
}

const keyOf = (a: Alternative): string => `${a.type}|${roleOf(a)}`;

/** A list of alternatives in a canonical order (by key), so no order of enumeration shows in a choice. */
function sortedAlternatives(list: readonly Alternative[]): readonly Alternative[] {
  return [...list].sort((x, y) => (keyOf(x) < keyOf(y) ? -1 : keyOf(x) > keyOf(y) ? 1 : 0));
}

/** Two lists of alternatives as one: the same key merged, in the canonical order. */
function mergedLists(
  left: readonly Alternative[],
  right: readonly Alternative[],
): readonly Alternative[] {
  const out = new Map<string, Alternative>();
  for (const a of [...left, ...right]) {
    const prior = out.get(keyOf(a));
    out.set(keyOf(a), prior === undefined ? a : merged(prior, a));
  }
  return sortedAlternatives([...out.values()]);
}

/** A dynamic item met along a projection of the dynamic view. */
interface DynamicMark {
  readonly tag: "d";
  readonly why: Provenance;
}

/**
 * Whether an object alternative lacks a slot that some store in the program gives objects (N-B2): its slots are its
 * own, so the property is read as `maybe absent` there, never as certainly absent.
 */
function lacksStoredSlot(cells: Cells, a: Alternative | DynamicMark, name: string): boolean {
  return (
    a.tag !== "d" &&
    a.choice?.props !== undefined &&
    !a.choice.props.has(name) &&
    cells.stored(name)
  );
}

/** Whether a property is absent in every alternative reached: no part cell for it and no written property. */
function absentEverywhere(
  cells: Cells,
  found: readonly (Alternative | DynamicMark)[],
  name: string,
): boolean {
  for (const a of found) {
    if (a.tag === "d") return false;
    if (a.choice?.props?.has(name) === true) return false;
    if (lacksStoredSlot(cells, a, name)) return false;
    const node = cells.table.node(a.type);
    if (
      node.kind === "object" &&
      node.properties !== null &&
      node.properties.some((p) => p.name === name)
    )
      return false;
  }
  return true;
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
function alternatives(
  cells: Cells,
  cell: CellId,
  path: ReadonlySet<CellId> = new Set(),
): readonly Alternative[] {
  // the budget's second cut point (`budget.ts`): a cell whose expansion exceeds the limit presents no alternative
  // and a `too complex` mark instead (`marksOf`, `provenances`), checked while expanding
  if (isCutCell(cells, cell)) return [];
  const out = new Map<string, Alternative>();
  for (const item of cells.items(cell)) {
    if (item.tag === "d" || item.tag === "e") continue;
    for (const alternative of itemAlternatives(cells, item, cell, path)) {
      const key = keyOf(alternative);
      const prior = out.get(key);
      if (prior === undefined) out.set(key, alternative);
      else out.set(key, merged(prior, alternative));
      if (overBudget("alternatives", out.size)) {
        cutCell(cells, cell, out.size);
        return [];
      }
    }
  }
  return [...out.values()];
}

/**
 * Two alternatives of one type from two items (sharing their parts, or alike) are one alternative that names every
 * cell and every item either was read from, down through the chosen parts, so a projection's sources do not depend
 * on which item was enumerated first.
 */
function merged(prior: Alternative, other: Alternative): Alternative {
  const cells = unionOf(prior.cells, other.cells);
  const items = [...prior.items, ...other.items.filter((item) => !prior.items.includes(item))];
  let choice = prior.choice;
  if (prior.choice !== null && other.choice !== null) {
    if (prior.choice.element !== undefined && other.choice.element !== undefined)
      choice = {
        element: merged(prior.choice.element, other.choice.element),
        cells: unionOf(prior.choice.cells, other.choice.cells),
      };
    else if (prior.choice.props !== undefined && other.choice.props !== undefined) {
      // two object items of one shape: their part cells per property, so a projection reads both (parts shared)
      const props = new Map(prior.choice.props);
      for (const [name, theirs] of other.choice.props)
        props.set(name, unionOf(props.get(name) ?? [], theirs));
      choice = { props, cells: props };
    }
  }
  const cases = [...new Set([...prior.cases, ...other.cases])].sort();
  return { ...prior, cells, items, choice, cases };
}

/** The case of an item as an alternative reads it: a witness is the cell's schema (option B), a member or a bound its own. */
export function caseOf(cells: Cells, item: Item, cell: CellId): string {
  return item.tag === "w" || item.tag === "n" ? `W${cell}` : (item.case ?? `c:${cells.name(cell)}`);
}

/**
 * The base cases a rebuilt collection is built from: a rebuilt case (`j{...}`) contributes its own bases, so a
 * feedback edge returns to the same case (I1).
 */
function basesOf(a: Alternative): readonly string[] {
  // a witness contributes no base (r6): a written or permitted member and a rebuilt collection identify what they
  // are built into, a literal does not, so appends at k sites stay k cases per member and a feedback edge still
  // returns to its case; a chain of distinct written unions stays 2^n and meets the budget
  return [
    ...new Set(
      a.cases.flatMap((c) =>
        c.startsWith("j{") ? c.slice(2, -1).split(",") : a.tag === "w" ? [] : [c],
      ),
    ),
  ].sort();
}

export function itemAlternatives(
  cells: Cells,
  item: Item,
  cell: CellId,
  path: ReadonlySet<CellId>,
): readonly Alternative[] {
  const table = cells.table;
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
  const base = {
    tag,
    group: item.group,
    why: item.why,
    cells: [cell],
    items: [item],
    cases: item.ctor === undefined ? [] : [caseOf(cells, item, cell)],
  };
  if (item.type !== undefined) return [{ ...base, type: item.type, choice: null }];
  if (item.parts === undefined || item.ctor === undefined) return [];
  const inner = new Set([...path, cell]);
  const synthetic = (type: StaticType, part: CellId): Alternative => ({
    type: table.intern(type),
    tag: "w",
    group: undefined,
    why: undefined,
    cells: [part],
    items: [],
    choice: null,
    cases: [],
  });
  const partAlternatives = (part: CellId): Alternative[] => {
    if (path.has(part) || part === cell) return [synthetic(UNKNOWN_TYPE, part)];
    const out = [...alternatives(cells, part, inner)];
    const items = cells.items(part);
    if (items.some((it) => it.tag === "e")) out.push(synthetic({ kind: "never" }, part));
    if (items.some((it) => it.tag === "d" || it.tag === "p") || isCutCell(cells, part))
      out.push(synthetic(UNKNOWN_TYPE, part));
    return out;
  };
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
      ...base,
      type: table.intern(type),
      tag: t,
      group: t === "m" ? (tag === "m" ? item.group : member?.group) : undefined,
      why: t === "p" ? (item.why ?? possible?.why) : undefined,
      choice,
    };
  };
  if (item.parts.props !== undefined) {
    // one alternative: the shape, the names the literal wrote and every name a store in the program gives objects
    // (the eager vocabulary slot's shape; N-B2 allocates the slots on demand but keeps the shape), every slot with
    // the placeholder `never` that no relation reads (a property's type is read as a leaf, one alternative per ask);
    // the shape of an item never changes, so the set only grows and two items of one shape are one alternative whose
    // part cells are read together, a relation's growing answers among them
    const props: ReadonlyMap<string, readonly CellId[]> = new Map(
      [...item.parts.props].sort(byName).map(([name, part]) => [name, [part]]),
    );
    if (item.parts.open === true)
      return [
        {
          ...base,
          type: table.intern({ kind: "object", properties: null }),
          choice: { props, cells: props },
        },
      ];
    const names = [...new Set([...item.parts.written, ...cells.storedNames])].sort();
    return [
      {
        ...base,
        type: table.intern({
          kind: "object",
          properties: new PropertyTable(names.map((name) => [name, { kind: "never" }])),
        }),
        choice: { props, cells: props },
      },
    ];
  }
  const element = item.parts.element;
  const ctor: Exclude<Constructor, "object"> = item.ctor === "object" ? "list" : item.ctor;
  return partAlternatives(element).map((a) =>
    compose({ kind: ctor, element: table.toStatic(a.type) }, [a], { element: a, cells: [element] }),
  );
}

/** The provenances of a cell's own dynamic items and possibilities, sorted; a part's provenance stays in the part. */
function provenances(cells: Cells, cell: CellId): readonly Provenance[] {
  const out = new Set<Provenance>();
  for (const item of cells.items(cell))
    if ((item.tag === "d" || item.tag === "p") && item.why !== undefined) out.add(item.why);
  if (isCutCell(cells, cell)) out.add(BUDGET_WHY);
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
    cells: a.cells,
    items: [],
    choice: null,
    cases: [],
  });
  if (a.choice !== null) {
    // the marks of every part cell the merged items hold the chosen part in
    const marks = (parts: readonly CellId[] | undefined): DynamicMark[] =>
      withDynamic && parts !== undefined
        ? parts.flatMap((part) =>
            cells
              .items(part)
              .filter((it) => it.tag === "d" && it.why !== undefined)
              .map((it) => ({ tag: "d", why: it.why! })),
          )
        : [];
    if (a.choice.props !== undefined) {
      if (typeof step !== "object") return [];
      // the property's alternatives from the part cells of the merged items, enumerated here afresh
      const parts = a.choice.props.get(step.property);
      if (parts === undefined) return [];
      return [
        ...mergedLists(
          parts.flatMap((part) => alternatives(cells, part)),
          [],
        ),
        ...marks(parts),
      ];
    }
    if (typeof step === "object") return [];
    if (node.kind === "dict" && step === "iteration") return [text()];
    return [a.choice.element, ...marks(a.choice.cells)];
  }
  if (typeof step === "object") {
    if (node.kind !== "object" || node.properties === null) return [];
    const property = node.properties.find((p) => p.name === step.property);
    return property === undefined ? [] : [{ ...a, type: property.type, items: [], choice: null }];
  }
  if (node.kind === "list" || node.kind === "set" || node.kind === "dict")
    return node.kind === "dict" && step === "iteration"
      ? [text()]
      : [{ ...a, type: node.element, items: [], choice: null }];
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
  /** Counts the operand combinations every chosen lift enumerated, before any lazy dimension (the budget's quantity). */
  combinations: number;
  /** Counts the states a fold carried across its arguments (states times choices, per argument). */
  foldStates: number;
}

/**
 * The counted combinations of one operation: cascades are not counted at all. A folded relation counts nothing and
 * names the arguments that can be invalid instead (`fold`, the owner's decision B).
 */
export interface Tally {
  readonly asked: number;
  readonly invalid: number;
  readonly fold?: readonly number[];
  /** The cut the budget made instead of asking (`budget.ts`). */
  readonly budget?: BudgetCut;
}

/** One choice of a dimension: an operand's, a leaf's, a place's, or the presence of a property a projection reads. */
type Pick =
  | {
      readonly kind: "closed" | "possible";
      readonly alt: Alternative;
      readonly view: OperandView;
      readonly tag: Alternative["tag"];
      readonly why: Provenance | undefined;
      readonly cells: readonly CellId[];
    }
  | {
      readonly kind: "bottom";
      readonly view: OperandView;
      readonly tag: "w";
      readonly why: undefined;
      readonly cells: readonly CellId[];
    }
  | {
      readonly kind: "dynamic";
      readonly view: OperandView;
      readonly tag: "d";
      readonly why: Provenance;
      readonly cells: readonly CellId[];
    }
  | {
      readonly kind: "absent" | "present";
      readonly view: null;
      readonly tag: "w";
      readonly why: undefined;
      readonly cells: readonly CellId[];
    }
  /**
   * The one pick of a collected operand (P1): every alternative at once, the view closed and the provenances of the
   * cell's dynamic values and possibilities beside it (`whys`), so the relation answers over the known alternatives
   * and the ask adds a dynamic result per provenance: the answer grows with the alternatives instead of collapsing to
   * unknown when one is unknown. An answer read from an aggregate is a member of the union the operation defines at
   * its site, so a single-option answer and a two-option answer are members of one union, not a witness beside members.
   */
  | {
      readonly kind: "aggregate";
      readonly view: OperandView;
      readonly tag: "m";
      readonly why: undefined;
      readonly cells: readonly CellId[];
      readonly whys: readonly Provenance[];
    };

/** The summed reads of one ask: whether one happened, and the provenances of the dynamic values met. */
interface Aggregated {
  used: boolean;
  readonly whys: Set<Provenance>;
}

interface Operand {
  readonly ref: OperandRef;
  readonly cell: CellId;
  readonly lazy: boolean;
}

/** A contribution read from an answer, before it enters the result cell. */
type Outcome =
  | {
      readonly kind: "type";
      readonly tag: "w" | "m" | "p";
      readonly type: TypeId;
      readonly group: string | undefined;
      readonly why: Provenance | undefined;
      readonly whys: readonly Provenance[];
      readonly from: readonly CellId[];
      /** The earliest site of a projected part's own evidence, the secondary position in the result (Q3.7). */
      readonly site: number | undefined;
      /** For a collection type: the part and case the combination's structures give it (I1). */
      readonly part?: string | undefined;
      readonly case?: string | undefined;
    }
  | {
      readonly kind: "item";
      readonly tag: "w" | "m" | "p";
      readonly item: Item;
      readonly group: string | undefined;
      readonly why: Provenance | undefined;
      readonly whys: readonly Provenance[];
      readonly from: readonly CellId[];
      readonly site: number | undefined;
    }
  | { readonly kind: "dynamic"; readonly why: Provenance }
  | {
      /** A structure the operation builds: its parts' outcomes go to the result's part cells (one per name). */
      readonly kind: "structure";
      readonly tag: "w" | "m" | "p";
      readonly ctor: "object" | "dict";
      readonly parts: ReadonlyMap<string, readonly Outcome[]>;
      readonly nullable: boolean;
      readonly group: string | undefined;
      readonly why: Provenance | undefined;
      readonly whys: readonly Provenance[];
    }
  | {
      readonly kind: "collection";
      readonly tag: "w" | "m" | "p";
      readonly ctor: Exclude<Constructor, "object">;
      readonly elements: readonly Outcome[];
      readonly group: string | undefined;
      readonly why: Provenance | undefined;
      readonly whys: readonly Provenance[];
      /**
       * The result's element cell, `element{B}` over the base cases of the structures the combination was asked about
       * (I1): one structure in, one structure out; two members of one shape stay two; a feedback edge returns to the
       * same case. `element` when no chosen structure contributed (a dynamic reading).
       */
      readonly part: string;
      readonly case: string | undefined;
    };

interface Reading {
  readonly base: "w" | "m" | "p";
  readonly site: string;
  /** The provenances of the combination's dynamic views and possibilities, for a possibility without one of its own. */
  readonly whys: readonly Provenance[];
  readonly mode: "closed" | "dynamic" | "possible";
  /** The provenances of the dynamic values among the combination's aggregate picks: a dynamic result each. */
  readonly aggregateWhys: readonly Provenance[];
}

/** The dimensions selected for one ask, by key, and the recorder of a dimension read before its selection. */
type Selection = ReadonlyMap<string, Pick>;
type Want = (key: string, picks: () => readonly Pick[]) => void;

const BOTTOM_VIEW: OperandView = { alternatives: null, dynamic: null, known: undefined };

const sameRef = (a: OperandRef, b: OperandRef): boolean =>
  "receiver" in a
    ? "receiver" in b
    : "argument" in a
      ? "argument" in b && a.argument === b.argument
      : "named" in a
        ? "named" in b && a.named === b.named
        : "place" in b && a.place === b.place;

const dynamicWhy = (why: Provenance): Exclude<Provenance, "unknown"> =>
  why === "unknown" ? "unknown callee" : why;

/** The dynamic items of a cell, as marks a dynamic walk carries. */
function marksOf(cells: Cells, cell: CellId): DynamicMark[] {
  const marks = cells
    .items(cell)
    .filter((it) => it.tag === "d" && it.why !== undefined)
    .map((it): DynamicMark => ({ tag: "d", why: it.why! }));
  if (isCutCell(cells, cell)) marks.push({ tag: "d", why: BUDGET_WHY });
  return marks;
}

/** Whether an alternative is working at interpretation (every alternative is while solving). */
function isWorking(nonWorking: ReadonlySet<string> | null, a: Alternative): boolean {
  return nonWorking === null || !a.cells.some((cell) => nonWorking.has(`${cell}:${a.type}`));
}

/** The choices of an operand or a place: its closed alternatives, its possibilities, one dynamic view per provenance, and, when lazy, nothing. */
function picksOf(cells: Cells, cell: CellId, lazy: boolean): Pick[] {
  const table = cells.table;
  const all = alternatives(cells, cell);
  const list: Pick[] = all.map((alt) => ({
    kind: alt.tag === "p" ? "possible" : "closed",
    alt,
    view: { alternatives: [table.toStatic(alt.type)], dynamic: null, known: undefined },
    tag: alt.tag,
    why: alt.why,
    cells: alt.cells,
  }));
  const types = all.map((alt) => table.toStatic(alt.type));
  for (const why of provenances(cells, cell))
    list.push({
      kind: "dynamic",
      view: {
        alternatives: types.length === 0 ? null : types,
        dynamic: dynamicWhy(why),
        known: undefined,
      },
      tag: "d",
      why,
      cells: [cell],
    });
  if (lazy) list.push({ kind: "bottom", view: BOTTOM_VIEW, tag: "w", why: undefined, cells: [] });
  return list;
}

/** The one pick of a collected operand or the aggregate view of a summed place (P1): every alternative at once. */
function aggregateOf(
  cells: Cells,
  cell: CellId,
  nonWorking: ReadonlySet<string> | null,
): Extract<Pick, { kind: "aggregate" }> {
  const table = cells.table;
  // at interpretation the non-working alternatives of a conflicting cell are not in the aggregate (the cascade rule
  // of the chosen reading: a choice of one is not counted)
  const all = alternatives(cells, cell).filter((a) => isWorking(nonWorking, a));
  return {
    kind: "aggregate",
    view: {
      alternatives: all.length === 0 ? null : all.map((a) => table.toStatic(a.type)),
      dynamic: null,
      known: undefined,
    },
    tag: "m",
    why: undefined,
    cells: [cell],
    whys: provenances(cells, cell).map(dynamicWhy),
  };
}

/**
 * The choices of a dimension a step reached: one per closed alternative and possibility, one dynamic view per
 * provenance, `absent` where the part may be absent, a single bottom where there is nothing yet (the relation decides
 * whether to wait).
 */
function picksFrom(
  cells: Cells,
  found: readonly (Alternative | DynamicMark)[],
  absence: boolean,
): Pick[] {
  const table = cells.table;
  const alts = found.filter((x): x is Alternative => x.tag !== "d");
  const list: Pick[] = alts.map((alt) => ({
    kind: alt.tag === "p" ? "possible" : "closed",
    alt,
    view: { alternatives: [table.toStatic(alt.type)], dynamic: null, known: undefined },
    tag: alt.tag,
    why: alt.why,
    cells: alt.cells,
  }));
  const whys = [...new Set(found.flatMap((x) => (x.tag === "d" ? [x.why] : [])))].sort();
  const types = alts.map((alt) => table.toStatic(alt.type));
  for (const why of whys)
    list.push({
      kind: "dynamic",
      view: {
        alternatives: types.length === 0 ? null : types,
        dynamic: dynamicWhy(why),
        known: undefined,
      },
      tag: "d",
      why,
      cells: [],
    });
  if (absence) list.push({ kind: "absent", view: null, tag: "w", why: undefined, cells: [] });
  if (list.length === 0)
    list.push({ kind: "bottom", view: BOTTOM_VIEW, tag: "w", why: undefined, cells: [] });
  return list;
}

/** The pick of a dimension: the selected one, or none, recorded as wanted, when it is not selected yet. */
function select(
  key: string,
  picks: () => readonly Pick[],
  selection: Selection,
  want: Want,
): Pick | null {
  const pick = selection.get(key);
  if (pick !== undefined) return pick;
  want(key, picks);
  return null;
}

/** The reading of a combination with its selected dimensions: the mode, the base tag and the provenances. */
function readingOf(combo: readonly Pick[], selection: Selection, site: string): Reading {
  const picks = [...combo, ...selection.values()];
  const mode: Reading["mode"] = picks.some((pick) => pick.kind === "possible")
    ? "possible"
    : picks.some((pick) => pick.kind === "dynamic")
      ? "dynamic"
      : "closed";
  // an aggregate pick (a collected operand) makes the answer a member (see the pick's documentation)
  const base: Reading["base"] =
    mode === "possible" ? "p" : picks.some((pick) => pick.tag === "m") ? "m" : "w";
  const whys = [
    ...new Set(
      picks.flatMap((pick) =>
        (pick.kind === "dynamic" || pick.kind === "possible") && pick.why !== undefined
          ? [pick.why]
          : [],
      ),
    ),
  ].sort();
  const aggregateWhys = [
    ...new Set(picks.flatMap((pick) => (pick.kind === "aggregate" ? pick.whys : []))),
  ].sort();
  return { base, site, whys, mode, aggregateWhys };
}

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
  const pos = positionAt(operation.site);
  if (relation === undefined)
    return {
      changed: cells.add(operation.result, { tag: "d", why: "unknown callee", pos }),
      tally: null,
    };
  // the operands the relation declares (P1, declared parameters): an argument outside the declaration is not a
  // dimension and is not read; a malformed call keeps the stage-4 arity error as its only consequence (r6-B4/B5)
  const { parameters } = relation;
  const positional =
    parameters.positional === "variadic"
      ? operation.arguments
      : operation.arguments.slice(0, parameters.positional);
  const named = operation.named.filter((entry) => parameters.named.includes(entry.name));
  const operands: Operand[] = [];
  if (operation.receiver !== null)
    operands.push({ ref: RECEIVER, cell: operation.receiver, lazy: false });
  positional.forEach((cell, index) =>
    operands.push({ ref: { argument: index }, cell, lazy: false }),
  );
  for (const entry of named)
    operands.push({
      ref: { named: entry.name },
      cell: entry.value,
      lazy: entry.name === "default",
    });
  if (operation.contract.family === "logic" && operands[1] !== undefined)
    operands[1] = { ...operands[1], lazy: true };
  // a strict operand without evidence: never; the relation is not asked
  for (const operand of operands)
    if (!operand.lazy && !cells.has(operand.cell)) return { changed: false, tally: null };
  const site = `op@${operation.site}`;
  const collected = relation.plan === "collected";
  const choices = operands.map((operand) =>
    collected && "argument" in operand.ref
      ? [aggregateOf(cells, operand.cell, context.nonWorking)]
      : picksOf(cells, operand.cell, operand.lazy),
  );
  if (choices.some((list) => list.length === 0)) return { changed: false, tally: null };
  if (
    relation.plan === "fold" &&
    operation.receiver === null &&
    named.length === 0 &&
    positional.length >= 2
  )
    return foldLift(context, operation, relation, operands, choices);
  // the budget's one cut point (`budget.ts`): the combinations of the operands' choices, counted before any lazy
  // dimension; above the limit the result is held and the status reports the count
  const combinations = choices.reduce((count, list) => count * list.length, 1);
  context.combinations += combinations;
  if (overBudget("combinations", combinations)) {
    const cut: BudgetCut = {
      quantity: "combinations",
      count: combinations,
      at: operation.site,
      operands: operands
        .map((operand, index) => ({ cell: operand.cell, count: choices[index]!.length }))
        .sort((a, b) => b.count - a.count),
    };
    return {
      changed: cells.add(operation.result, { tag: "d", why: BUDGET_WHY, pos }),
      tally: { asked: 0, invalid: 0, budget: cut },
    };
  }
  const combos = product(choices);
  let changed = false;
  let asked = 0;
  let invalid = 0;
  for (const combo of combos) {
    const asks = askLazy(
      context,
      (inputs) => relation.result(inputs),
      operands,
      combo,
      operation,
      site,
      new Map(),
    );
    for (const { reading, selection } of asks) {
      const from = [
        ...combo.flatMap((pick, index) =>
          pick.kind === "closed" ? [`${operands[index]!.cell}:${pick.alt.type}`] : [],
        ),
        ...[...selection.values()].flatMap((pick) =>
          pick.kind === "closed" ? pick.cells.map((cell) => `${cell}:${pick.alt.type}`) : [],
        ),
      ];
      const cascade =
        context.nonWorking !== null && from.some((key) => context.nonWorking!.has(key));
      if (!cascade) asked += 1; // a cascade combination is not counted at all; its valid evidence still stands
      if (reading.invalid && !cascade) invalid += 1;
      for (const outcome of reading.outcomes)
        if (emit(cells, operation.result, outcome, pos)) changed = true;
    }
  }
  return { changed, tally: { asked, invalid } };
}

interface Ask {
  readonly reading: { readonly outcomes: readonly Outcome[]; readonly invalid: boolean };
  readonly selection: Selection;
}

/** Whether a receiver item has `get`: a list by index or a dict by key; a set, a scalar or null has none (Q3.9). */
export const getApplies = (item: Item): boolean => item.ctor === "list" || item.ctor === "dict";

/**
 * The combinations a `get` constraint counts (Q2's own constraint kind), as the member relations count theirs: one per
 * choice of the receiver, a list or a dict alternative valid, any other (a set, a scalar, null) invalid, a dynamic view
 * asked and valid, a choice of a non-working alternative a cascade that is not counted; a strict key without evidence
 * asks nothing (PR review r5-B6).
 */
export function getTally(context: LiftContext, receiver: CellId, key: CellId | null): Tally {
  const { cells } = context;
  if (!cells.has(receiver) || (key !== null && !cells.has(key))) return { asked: 0, invalid: 0 };
  let asked = 0;
  let invalid = 0;
  for (const pick of picksOf(cells, receiver, false)) {
    if (pick.kind === "closed" || pick.kind === "possible") {
      if (context.nonWorking !== null && context.nonWorking.has(`${receiver}:${pick.alt.type}`))
        continue;
      asked += 1;
      if (!pick.alt.items.some(getApplies)) invalid += 1;
    } else if (pick.kind === "dynamic") asked += 1;
  }
  return { asked, invalid };
}

/** Every choice of one pick per operand. */
function product(lists: readonly (readonly Pick[])[]): Pick[][] {
  return lists.reduce<Pick[][]>(
    (acc, list) => acc.flatMap((combo) => list.map((pick) => [...combo, pick])),
    [[]],
  );
}

/** The places an operation's syntax evidence names: its declared inputs beside the operands (P1). */
export function evidencePlaces(evidence: SyntaxEvidence | undefined): readonly PlaceId[] {
  const out = new Set<PlaceId>();
  const keys = new Set(["place", "value", "text", "min", "max"]);
  const walk = (node: unknown, key: string): void => {
    if (node === null || node === undefined) return;
    if (typeof node === "number") {
      if (keys.has(key)) out.add(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const x of node) walk(x, key);
      return;
    }
    if (typeof node === "object") for (const [k, v] of Object.entries(node)) walk(v, k);
  };
  walk(evidence, "");
  return [...out].sort((a, b) => a - b);
}

/** A fold's state: the view the arguments so far give, with the tag, provenance and sources that reached it. */
interface FoldState {
  readonly view: OperandView;
  readonly tag: "w" | "m" | "p" | "d";
  readonly why: Provenance | undefined;
}

/**
 * The fold of `min` or `max` over its arguments (P1, the owner's decision B on the status): the states after the first
 * argument are its choices; each further argument is folded in by the relation's binary law, one ask per state and
 * choice, so the asks grow with the arguments. The results are the final states: a type tagged m when a member
 * contributed (the operation's site as identity), p for a possibility (its provenance), d for a dynamic reading. At
 * interpretation the status names the arguments that can be invalid: one whose working choice cannot be ordered at
 * all (asked against itself), and the two of a pair of orderable choices that cannot be ordered together, asked once
 * per distinct type and pair of types across the call; no combination is counted.
 */
function foldLift(
  context: LiftContext,
  operation: Operation,
  relation: OperationRelation,
  operands: readonly Operand[],
  choices: readonly (readonly Pick[])[],
): { readonly changed: boolean; readonly tally: Tally | null } {
  const { cells } = context;
  const table = cells.table;
  const pos = positionAt(operation.site);
  // a fold reads its two views alone: a place read is undeclared, as for the ordinary wrapper (Astra r6-N1)
  const undeclared = (place: PlaceId): never => {
    throw new Error(
      `undeclared read of place ${place} by ${operation.contract.family}.${operation.contract.name}@${operation.site}`,
    );
  };
  const ask = (left: OperandView, right: OperandView): OperationResult => {
    context.asks += 1;
    return relation.result({
      receiver: null,
      arguments: [left, right],
      named: new Map(),
      evidence: operation.evidence,
      view: (place) => undeclared(place),
      collect: (place) => undeclared(place),
      leaf: (path) => ("place" in path.of ? undeclared(path.of.place) : BOTTOM_VIEW),
    });
  };
  const viewOf = (pick: Pick): OperandView => pick.view ?? BOTTOM_VIEW;
  const typeOf = (view: OperandView): string =>
    view.alternatives === null ? "-" : view.alternatives.map((t) => table.intern(t)).join("|");
  const keyOfState = (st: FoldState): string =>
    `${typeOf(st.view)}|${st.view.dynamic ?? ""}|${st.tag}|${st.why ?? ""}`;
  const mergeState = (map: Map<string, FoldState>, st: FoldState): void => {
    const key = keyOfState(st);
    if (!map.has(key)) map.set(key, st);
  };
  const tagOf = (pick: Pick): FoldState["tag"] =>
    pick.kind === "possible" ? "p" : pick.kind === "dynamic" ? "d" : pick.tag === "m" ? "m" : "w";
  let states = new Map<string, FoldState>();
  for (const pick of choices[0]!)
    mergeState(states, {
      view: viewOf(pick),
      tag: tagOf(pick),
      why: pick.kind === "possible" || pick.kind === "dynamic" ? pick.why : undefined,
    });
  for (let index = 1; index < choices.length; index += 1) {
    const next = new Map<string, FoldState>();
    for (const st of states.values())
      for (const pick of choices[index]!) {
        context.foldStates += 1;
        const answer = ask(st.view, viewOf(pick));
        const pickTag = tagOf(pick);
        const tag: FoldState["tag"] =
          st.tag === "p" || pickTag === "p"
            ? "p"
            : st.tag === "d" || pickTag === "d"
              ? "d"
              : st.tag === "m" || pickTag === "m"
                ? "m"
                : "w";
        const why =
          tag === "p" || tag === "d"
            ? (st.why ??
              (pick.kind === "possible" || pick.kind === "dynamic" ? pick.why : undefined))
            : undefined;
        const results = answer.kind === "alternatives" ? answer.results : [answer];
        for (const r of results) {
          if (r.kind === "type")
            mergeState(next, {
              view: { alternatives: [r.type], dynamic: null, known: undefined },
              tag,
              why,
            });
          else if (r.kind === "possible")
            for (const t of r.types)
              mergeState(next, {
                view: { alternatives: [t], dynamic: null, known: undefined },
                tag: "p",
                why: r.why,
              });
          else if (r.kind === "dynamic")
            mergeState(next, {
              view: { alternatives: null, dynamic: r.why, known: undefined },
              tag: "d",
              why: r.why,
            });
        }
      }
    states = next;
  }
  let changed = false;
  const site = `op@${operation.site}`;
  for (const st of states.values()) {
    if (st.tag === "d") {
      if (cells.add(operation.result, { tag: "d", why: st.why ?? "unknown", pos })) changed = true;
      continue;
    }
    for (const t of st.view.alternatives ?? [])
      if (
        cells.add(operation.result, {
          tag: st.tag,
          type: table.intern(t),
          group: st.tag === "m" ? site : undefined,
          why: st.tag === "p" ? st.why : undefined,
          pos,
          from: [],
        })
      )
        changed = true;
  }
  if (context.nonWorking === null) return { changed, tally: { asked: 0, invalid: 0, fold: [] } };
  // the status, once over the final cells: the arguments whose working choices cannot be ordered, alone or together
  const working = (pick: Pick, index: number): boolean =>
    (pick.kind === "closed" || pick.kind === "possible") &&
    !context.nonWorking!.has(`${operands[index]!.cell}:${pick.alt.type}`);
  const typesOf = choices.map(
    (list, index) =>
      new Map(
        list
          .filter((pick) => working(pick, index))
          .map(
            (pick) =>
              [
                String(pick.kind === "closed" || pick.kind === "possible" ? pick.alt.type : ""),
                viewOf(pick),
              ] as const,
          ),
      ),
  );
  const views = new Map(typesOf.flatMap((m) => [...m]));
  const alone = new Map([...views].map(([k, v]) => [k, ask(v, v).kind === "invalid"] as const));
  const keys = [...views.keys()].sort();
  const pairInvalid = new Map<string, boolean>();
  for (let a = 0; a < keys.length; a += 1)
    for (let b = a + 1; b < keys.length; b += 1)
      if (!alone.get(keys[a]!) && !alone.get(keys[b]!))
        pairInvalid.set(
          `${keys[a]}|${keys[b]}`,
          ask(views.get(keys[a]!)!, views.get(keys[b]!)!).kind === "invalid",
        );
  // how many arguments hold each type, so "another argument holds u" is a count, not a scan of the arguments: the
  // blame is linear in the arguments for a bounded number of types (r6-B3/B4)
  const holders = new Map<string, number>();
  for (const mine of typesOf)
    for (const k of mine.keys()) holders.set(k, (holders.get(k) ?? 0) + 1);
  const blamed = new Set<number>();
  typesOf.forEach((mine, index) => {
    for (const k of mine.keys()) {
      if (alone.get(k)) {
        blamed.add(index);
        continue;
      }
      for (const u of keys) {
        if (alone.get(u)) continue;
        const elsewhere = (holders.get(u) ?? 0) - (mine.has(u) ? 1 : 0);
        if (elsewhere > 0 && pairInvalid.get(k < u ? `${k}|${u}` : `${u}|${k}`)) {
          blamed.add(index);
          break;
        }
      }
    }
  });
  return { changed, tally: { asked: 0, invalid: 0, fold: [...blamed].sort((x, y) => x - y) } };
}

/**
 * Asks a result function over one operand combination, selecting the dimensions it reads lazily, depth first: every
 * completed ask with its selection.
 */
function askLazy(
  context: LiftContext,
  fn: (inputs: OperationInputs) => OperationResult,
  operands: readonly Operand[],
  combo: readonly Pick[],
  operation: Operation,
  site: string,
  selection: Selection,
): Ask[] {
  const { cells } = context;
  const asks: Ask[] = [];
  // the bound (P1): one completed ask per combination of the dimensions this ask selected, which the depth-first
  // selection enumerates exactly; a structure's parts are asked on their own, each within its own bound
  const dims = new Map<string, number>();
  const run = (selected: Selection): void => {
    // the first dimension read before its selection, recorded by the closures below
    const wanted: { current: { readonly key: string; readonly picks: readonly Pick[] } | null } = {
      current: null,
    };
    const want: Want = (key, picks) => {
      if (wanted.current === null) {
        const list = picks();
        wanted.current = { key, picks: list };
        dims.set(key, Math.max(dims.get(key) ?? 0, list.length));
      }
    };
    const aggregated: Aggregated = { used: false, whys: new Set() };
    const inputs = inputsOf(
      cells,
      operands,
      combo,
      operation,
      selected,
      want,
      aggregated,
      context.nonWorking,
    );
    const answer = fn(inputs);
    let reading: Ask["reading"] | null = null;
    if (wanted.current === null)
      reading = readAnswer(
        context,
        answer,
        combo,
        operands,
        readingOf(combo, selected, site),
        operation,
        site,
        selected,
        want,
        aggregated,
      );
    if (wanted.current !== null) {
      const { key, picks } = wanted.current;
      for (const pick of picks) run(new Map([...selected, [key, pick]]));
      return;
    }
    // every completed ask counts, the nested asks of a structure's parts too (r4-B3's measurement)
    context.asks += 1;
    asks.push({ reading: reading!, selection: selected });
  };
  run(selection);
  const bound = [...dims.values()].reduce((acc, n) => acc * Math.max(1, n), 1);
  if (asks.length > bound)
    throw new Error(`asks above the bound at ${site}: ${asks.length} > ${bound}`);
  return asks;
}

/** The inputs of one ask: the operands' views, and the dimensions read through them, selected or recorded. */
function inputsOf(
  cells: Cells,
  operands: readonly Operand[],
  combo: readonly Pick[],
  operation: Operation,
  selection: Selection,
  want: Want,
  aggregated: Aggregated = { used: false, whys: new Set() },
  nonWorking: ReadonlySet<string> | null,
): OperationInputs {
  let receiver: OperandView | null = null;
  const args: OperandView[] = [];
  const named = new Map<string, OperandView>();
  operands.forEach((operand, index) => {
    const view = combo[index]!.view ?? BOTTOM_VIEW;
    if ("receiver" in operand.ref) receiver = view;
    else if ("argument" in operand.ref) args[operand.ref.argument] = view;
    else if ("named" in operand.ref) named.set(operand.ref.named, view);
  });
  const table = cells.table;
  // a place a relation reads must be one the evidence declares (P1): the schedule depends on those alone
  const declared = new Set(evidencePlaces(operation.evidence));
  const declare = (place: PlaceId): void => {
    if (!declared.has(place))
      throw new Error(
        `undeclared read of place ${place} by ${operation.contract.family}.${operation.contract.name}@${operation.site}`,
      );
  };
  const placePick = (place: PlaceId): Pick | null => {
    declare(place);
    return select(`p:${place}`, () => picksOf(cells, place, false), selection, want);
  };
  // the view of a whole cell under a dynamic walk: every alternative beside the provenance
  const dynamicViewOf = (found: readonly (Alternative | DynamicMark)[]): OperandView => {
    const alts = [
      ...new Map(
        found
          .filter((a): a is Alternative => a.tag !== "d" && a.tag !== "p")
          .map((a) => [a.type, table.toStatic(a.type)] as const),
      ).values(),
    ];
    const mark = found.find((a): a is DynamicMark => a.tag === "d");
    return {
      alternatives: alts.length === 0 ? null : alts,
      dynamic: mark === undefined ? null : dynamicWhy(mark.why),
      known: undefined,
    };
  };
  return {
    receiver,
    arguments: args,
    named,
    evidence: operation.evidence,
    view(place) {
      const pick = placePick(place);
      return pick === null ? BOTTOM_VIEW : (pick.view ?? BOTTOM_VIEW);
    },
    collect(place) {
      // a summed read: the closed aggregate of the alternatives, the dynamic provenances recorded for the ask's result
      // (a place with dynamic values alone is bottom to the relation: the ask waits, and the recorded provenances give
      // the result its dynamic marks, as the chosen reading's dynamic pick did)
      declare(place);
      if (!cells.has(place)) return BOTTOM_VIEW;
      const pick = aggregateOf(cells, place, nonWorking);
      aggregated.used = true;
      for (const why of pick.whys) aggregated.whys.add(why);
      return pick.view;
    },
    leaf(path) {
      let key: string;
      let dynamicWalk = false;
      let found: readonly (Alternative | DynamicMark)[];
      if ("place" in path.of && path.of.collected === true) {
        // the collected walk of a summed place: every alternative stepped together, the leaves as one aggregate
        declare(path.of.place);
        found = [
          ...alternatives(cells, path.of.place).filter((a) => isWorking(nonWorking, a)),
          ...marksOf(cells, path.of.place),
        ];
        if (found.length === 0) return BOTTOM_VIEW;
        // the closed alternatives decide the leaf; the dynamic marks met add a dynamic result to the ask (recorded
        // here), so an alternative without the part reads as absent beside a value the compiler cannot know, as the
        // chosen reading of the two did one at a time
        const rootClosed = found.some((a) => a.tag !== "d");
        aggregated.used = true;
        for (const a of found)
          if (a.tag === "d" || a.tag === "p") aggregated.whys.add(dynamicWhy(a.why ?? "unknown"));
        // a slot is read by what it is by construction, never by what has arrived (r6): a slot no alternative's
        // shape has is absent; a slot whose cell holds nothing yet is pending (the ask waits); a slot empty by
        // construction (`e`) is absent beside whatever evidence the other alternatives hold (the chosen reading's
        // `absent` pick), told to the relation as `absent` on the view
        let pending = false;
        let maybeAbsent = false;
        let dynamicMet = false;
        for (const along of path.path) {
          if (typeof along === "object") {
            if (absentEverywhere(cells, found, along.property)) return null;
            for (const a of found)
              if (a.tag !== "d") {
                if (lacksStoredSlot(cells, a, along.property)) maybeAbsent = true;
                for (const part of a.choice?.props?.get(along.property) ?? []) {
                  const items = cells.items(part);
                  if (items.length === 0) pending = true;
                  else if (items.some((it) => it.tag === "e")) maybeAbsent = true;
                }
              }
          }
          found = found.flatMap((a) => stepOf(cells, a, along, true));
          for (const a of found) if (a.tag === "d") aggregated.whys.add(dynamicWhy(a.why));
          // a part's dynamic evidence reads as a synthetic `unknown` alternative beside its values (the chosen
          // reading's own dynamic pick); summed, it is the ask's provenance, never a member that absorbs the sum
          found = found.filter((a) => {
            if (a.tag !== "d" && !isWorking(nonWorking, a)) return false;
            if (a.tag === "d") {
              dynamicMet = true;
              return true;
            }
            if (a.items.length > 0 || cells.table.node(a.type).kind !== "unknown") return true;
            dynamicMet = true;
            const whys = a.cells.flatMap((part) => provenances(cells, part));
            for (const why of whys.length === 0 ? ["unknown" as const] : whys)
              aggregated.whys.add(dynamicWhy(why));
            return false;
          });
        }
        const closed = dynamicViewOf(found.filter((a) => a.tag !== "d"));
        if (closed.alternatives !== null)
          return maybeAbsent
            ? { alternatives: closed.alternatives, dynamic: null, known: undefined, absent: true }
            : { alternatives: closed.alternatives, dynamic: null, known: undefined };
        if (pending || !rootClosed) return BOTTOM_VIEW;
        // nothing closed reached beside a closed root: what was met is dynamic (recorded on the ask), read as an
        // empty closed view, the chosen reading's dynamic pick; nothing met at all is absent (the slots empty by
        // construction, or a part no alternative has)
        return dynamicMet
          ? maybeAbsent
            ? { alternatives: [], dynamic: null, known: undefined, absent: true }
            : { alternatives: [], dynamic: null, known: undefined }
          : null;
      }
      if ("place" in path.of) {
        const pick = placePick(path.of.place);
        if (
          pick === null ||
          pick.kind === "bottom" ||
          pick.kind === "absent" ||
          pick.kind === "present"
        )
          return BOTTOM_VIEW;
        if (pick.kind === "dynamic") {
          dynamicWalk = true;
          found = [...alternatives(cells, path.of.place), ...marksOf(cells, path.of.place)];
        } else if (pick.kind === "closed" || pick.kind === "possible") found = [pick.alt];
        else return BOTTOM_VIEW;
        key = `p:${path.of.place}`;
      } else {
        const index = operands.findIndex((operand) => sameRef(operand.ref, path.of));
        if (index < 0) return BOTTOM_VIEW;
        const pick = combo[index]!;
        if (pick.kind === "bottom" || pick.kind === "absent" || pick.kind === "present")
          return BOTTOM_VIEW;
        if (pick.kind === "dynamic" || pick.kind === "aggregate") {
          dynamicWalk = true;
          const cell = operands[index]!.cell;
          found = [...alternatives(cells, cell), ...marksOf(cells, cell)];
        } else if (pick.kind === "closed" || pick.kind === "possible") found = [pick.alt];
        else return BOTTOM_VIEW;
        key = `o:${index}`;
      }
      for (const along of path.path) {
        key += typeof along === "object" ? `.${along.property}` : `.${along}`;
        if (dynamicWalk) {
          found = found.flatMap((a) => stepOf(cells, a, along, true));
          continue;
        }
        let absence = false;
        if (typeof along === "object") {
          // a property step: absent where no alternative's shape has the slot; maybe absent where a slot is empty
          // by construction beside evidence
          const parts = found.flatMap((a) =>
            a.tag !== "d" && a.choice?.props !== undefined
              ? (a.choice.props.get(along.property) ?? [])
              : [],
          );
          const lacking = found.some((a) => lacksStoredSlot(cells, a, along.property));
          if (found.every((a) => a.tag !== "d") && parts.length === 0 && !lacking) return null;
          absence = lacking || parts.some((part) => cells.items(part).some((it) => it.tag === "e"));
        }
        const stepped = found.flatMap((a) => stepOf(cells, a, along, true));
        const pick = select(key, () => picksFrom(cells, stepped, absence), selection, want);
        if (pick === null || pick.kind === "bottom") return BOTTOM_VIEW;
        if (pick.kind === "absent") return null;
        if (pick.kind === "present") {
          found = stepped;
          continue;
        }
        if (pick.kind === "dynamic") {
          dynamicWalk = true;
          found = stepped;
          continue;
        }
        if (pick.kind === "closed" || pick.kind === "possible") found = [pick.alt];
      }
      if (dynamicWalk) return dynamicViewOf(found);
      const a = found.find((x): x is Alternative => x.tag !== "d");
      return a === undefined
        ? BOTTOM_VIEW
        : { alternatives: [table.toStatic(a.type)], dynamic: null, known: undefined };
    },
  };
}

/**
 * The base cases of the structures a combination was asked about (I1): the chosen alternatives' cases, over the given
 * operands or all. A dynamic reading contributes no case: what it yields is its own structure (the result's plain
 * part), never a set that depends on the alternatives present.
 */
function basesOfCombo(
  combo: readonly Pick[],
  operands: readonly Operand[],
  only: readonly OperandRef[] | null,
): readonly string[] {
  const bases = new Set<string>();
  combo.forEach((pick, index) => {
    if (only !== null && !only.some((ref) => sameRef(ref, operands[index]!.ref))) return;
    if (pick.kind === "closed" || pick.kind === "possible")
      for (const b of basesOf(pick.alt)) bases.add(b);
  });
  return [...bases].sort();
}

function readAnswer(
  context: LiftContext,
  answer: OperationResult,
  combo: readonly Pick[],
  operands: readonly Operand[],
  reading: Reading,
  operation: Operation,
  site: string,
  selection: Selection,
  want: Want,
  aggregated: Aggregated = { used: false, whys: new Set() },
): { readonly outcomes: readonly Outcome[]; readonly invalid: boolean } {
  const { cells } = context;
  const table = cells.table;
  const outcomes: Outcome[] = [];
  let invalid = false;
  // an answer read from an aggregate is a member of the union the operation defines at its site
  const own = (member: boolean, possible: boolean): "w" | "m" | "p" =>
    possible
      ? "p"
      : member || aggregated.used || reading.aggregateWhys.length > 0 || hasAggregate(combo)
        ? "m"
        : reading.mode === "dynamic"
          ? "w"
          : reading.base;
  // the case the combination's structures give a collection the operation answers with (I1)
  const cased = (type: StaticType): { readonly part?: string; readonly case?: string } => {
    if (type.kind !== "list" && type.kind !== "set" && type.kind !== "dict") return {};
    const bases = basesOfCombo(combo, operands, null);
    return bases.length > 0
      ? { part: `element{${bases.join(",")}}`, case: `j{${bases.join(",")}}` }
      : {};
  };
  const walk = (a: OperationResult, member: boolean, possible: boolean): void => {
    switch (a.kind) {
      case "type": {
        const tag = own(member, possible);
        outcomes.push({
          kind: "type",
          tag,
          type: table.intern(a.type),
          group: tag === "m" ? reading.site : undefined,
          why: undefined,
          whys: reading.whys,
          from: [],
          site: undefined,
          ...cased(a.type),
        });
        break;
      }
      case "possible":
        for (const type of a.types)
          outcomes.push({
            kind: "type",
            tag: "p",
            type: table.intern(type),
            group: undefined,
            why: a.why,
            whys: reading.whys,
            from: [],
            site: undefined,
            ...cased(type),
          });
        break;
      case "dynamic":
        outcomes.push({ kind: "dynamic", why: a.why });
        break;
      case "invalid":
        invalid = true;
        break;
      case "unconstrained":
        break;
      case "projection": {
        const projected = project(
          cells,
          a.source,
          combo,
          operands,
          reading,
          member,
          possible,
          selection,
          want,
        );
        if (projected === null) invalid = true;
        else outcomes.push(...projected);
        break;
      }
      case "join": {
        const tag = own(member, possible);
        const elements: Outcome[] = [];
        for (const part of a.parts) {
          const projected = project(
            cells,
            part,
            combo,
            operands,
            reading,
            member,
            possible,
            selection,
            want,
          );
          if (projected === null) {
            invalid = true;
            return;
          }
          elements.push(...projected);
        }
        // a rebuilt collection's case is the set of base cases of the chosen structures it is built from (I1): one
        // structure in, one structure out; two members of one shape stay two; a feedback edge returns to the same case
        const bases = basesOfCombo(
          combo,
          operands,
          a.parts.map((path) => path.of),
        );
        outcomes.push({
          kind: "collection",
          tag,
          ctor: a.constructor,
          elements,
          group: tag === "m" ? reading.site : undefined,
          why: undefined,
          whys: reading.whys,
          part: bases.length > 0 ? `element{${bases.join(",")}}` : "element",
          case: bases.length > 0 ? `j{${bases.join(",")}}` : undefined,
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
        if (pick.kind !== "closed" && pick.kind !== "possible" && pick.kind !== "dynamic") break;
        if (pick.kind === "dynamic") {
          // under a dynamic receiver every applicable case is conditional on the kind: possibilities
          const kinds = (pick.view.alternatives ?? []).map((type) =>
            kindOf(table.node(table.intern(type))),
          );
          for (const c of a.cases)
            if (kinds.length === 0 || kinds.includes(c.receiver)) walk(c.result, member, true);
          break;
        }
        if (pick.kind !== "closed" && pick.kind !== "possible") break;
        const kind = kindOf(table.node(pick.alt.type));
        for (const c of a.cases) if (c.receiver === kind) walk(c.result, member, possible);
        break;
      }
      case "structure": {
        // each part is asked on its own over the same operand combination and selection, its dimensions selected
        // lazily; its outcomes go to the result's part cell
        const tag = own(member, possible);
        const parts = new Map<string, readonly Outcome[]>();
        for (const [name, part] of a.parts) {
          const collected: Outcome[] = [];
          for (const ask of askLazy(context, part, operands, combo, operation, site, selection))
            collected.push(...ask.reading.outcomes);
          parts.set(name, collected);
        }
        outcomes.push({
          kind: "structure",
          tag,
          ctor: a.constructor,
          parts,
          nullable: a.nullable,
          group: tag === "m" ? reading.site : undefined,
          why: undefined,
          whys: reading.whys,
        });
        break;
      }
    }
  };
  walk(answer, false, reading.mode === "possible");
  // the dynamic values and possibilities among the aggregates read: a dynamic result per provenance beside the answer
  for (const why of [...new Set([...aggregated.whys, ...reading.aggregateWhys])].sort())
    outcomes.push({ kind: "dynamic", why });
  return { outcomes, invalid };
}

const hasAggregate = (combo: readonly Pick[]): boolean =>
  combo.some((pick) => pick.kind === "aggregate");

/**
 * A projection: through the combination's chosen alternative of the operand (nothing for an unevaluated lazy
 * operand); for the dynamic view, through every alternative and dynamic item of the operand's cell. A property step
 * whose slot is empty by construction beside evidence is a dimension (present or absent): the absent reading is an
 * invalid combination (`null`), the runtime check of a property that may be missing; a slot certainly empty is absent
 * alone. A structural alternative reached is carried as its item, parts shared; the alternative's cell is the
 * contribution's source.
 */
function project(
  cells: Cells,
  source: OperandPath,
  combo: readonly Pick[],
  operands: readonly Operand[],
  reading: Reading,
  member: boolean,
  possible: boolean,
  selection: Selection,
  want: Want,
): readonly Outcome[] | null {
  const index = operands.findIndex((operand) => sameRef(operand.ref, source.of));
  if (index < 0) return [];
  const pick = combo[index]!;
  if (
    pick.kind !== "closed" &&
    pick.kind !== "possible" &&
    pick.kind !== "dynamic" &&
    pick.kind !== "aggregate"
  )
    return [];
  const dynamicWalk = pick.kind === "dynamic" || pick.kind === "aggregate";
  const cell = operands[index]!.cell;
  let found: readonly (Alternative | DynamicMark)[] = dynamicWalk
    ? [...alternatives(cells, cell), ...marksOf(cells, cell)]
    : [pick.alt];
  // a part read through a permitted member is a member of the same union (Dropje97's W3-B1): the element of the list
  // `get` chose is permitted as the list is; a witness element under a witness collection stays a witness
  const via = !dynamicWalk && pick.alt.tag === "m" ? pick.alt : null;
  let key = `o:${index}`;
  for (const step of source.path) {
    key += typeof step === "object" ? `.${step.property}` : `.${step}`;
    if (typeof step === "object" && !dynamicWalk) {
      const parts = found.flatMap((a) =>
        a.tag !== "d" && a.choice?.props !== undefined
          ? (a.choice.props.get(step.property) ?? [])
          : [],
      );
      const present = parts.some((part) => cells.items(part).some((it) => it.tag !== "e"));
      const absent =
        found.some((a) => lacksStoredSlot(cells, a, step.property)) ||
        parts.some((part) => cells.items(part).some((it) => it.tag === "e"));
      if (absent) {
        const picks = (): Pick[] => [
          ...(present
            ? [{ kind: "present", view: null, tag: "w", why: undefined, cells: [] } as const]
            : []),
          { kind: "absent", view: null, tag: "w", why: undefined, cells: [] } as const,
        ];
        const chosen = select(`${key}?`, picks, selection, want);
        if (chosen === null) return [];
        if (chosen.kind === "absent") return null;
      }
    }
    found = found.flatMap((a) => stepOf(cells, a, step, dynamicWalk));
  }
  return found.flatMap((a): Outcome[] => {
    if (a.tag === "d") return [{ kind: "dynamic", why: a.why }];
    const viaMember = via !== null && a.tag === "w";
    const tag: "w" | "m" | "p" =
      a.tag === "p" || possible ? "p" : member || viaMember ? "m" : a.tag;
    const group =
      tag !== "m" ? undefined : member ? reading.site : viaMember ? via!.group : a.group;
    const why = tag !== "p" ? undefined : a.tag === "p" ? a.why : undefined;
    // a projected part keeps the earliest site of its own evidence as the secondary position (Q3.7: the earliest
    // member or operand by source position decides a collection built from several)
    const site = a.items.length === 0 ? undefined : Math.min(...a.items.map((item) => item.pos[0]));
    const structural = a.items.filter((item) => item.ctor !== undefined);
    if (structural.length > 0)
      return structural.map((item) => ({
        kind: "item",
        tag,
        item,
        group,
        why,
        whys: reading.whys,
        from: a.cells,
        site,
      }));
    return [
      { kind: "type", tag, type: a.type, group, why, whys: reading.whys, from: a.cells, site },
    ];
  });
}

/**
 * Adds an outcome to the result cell: a flat type, a carried item (parts shared), a dynamic mark, or a collection
 * whose elements go to the result's derived part cell (empty by construction when a projected part is never or
 * there is none). A possibility without a provenance of its own takes each provenance of its combination.
 */
function emit(cells: Cells, result: CellId, outcome: Outcome, at: Position): boolean {
  if (outcome.kind === "dynamic") return cells.add(result, { tag: "d", why: outcome.why, pos: at });
  const pos: Position =
    outcome.kind !== "collection" && outcome.kind !== "structure" && outcome.site !== undefined
      ? [at[0], outcome.site]
      : at;
  const whys: readonly (Provenance | undefined)[] =
    outcome.tag === "p" && outcome.why === undefined ? outcome.whys : [outcome.why];
  let changed = false;
  for (const why of whys) {
    switch (outcome.kind) {
      case "item":
        if (
          cells.add(result, {
            tag: outcome.tag,
            ctor: outcome.item.ctor,
            parts: outcome.item.parts,
            case: outcome.item.case,
            group: outcome.group,
            why,
            pos,
            from: outcome.from,
          })
        )
          changed = true;
        break;
      case "collection": {
        const element = cells.derived(result, outcome.part);
        const table = cells.table;
        const empty =
          outcome.elements.length === 0 ||
          outcome.elements.some((e) => e.kind === "type" && table.node(e.type).kind === "never");
        if (empty && cells.add(element, { tag: "e", pos })) changed = true;
        for (const part of outcome.elements) if (emit(cells, element, part, pos)) changed = true;
        if (
          cells.add(result, {
            tag: outcome.tag,
            ctor: outcome.ctor,
            parts: { element },
            case: outcome.case ?? `c:${cells.name(result)}`,
            group: outcome.group,
            why,
            pos,
          })
        )
          changed = true;
        break;
      }
      case "type":
        if (
          cells.add(result, {
            tag: outcome.tag,
            type: outcome.type,
            group: outcome.group,
            why,
            pos,
            from: outcome.from,
            part: outcome.part,
            case: outcome.case,
          })
        )
          changed = true;
        break;
      case "structure": {
        if (outcome.ctor === "object") {
          const props = new Map<string, CellId>();
          for (const [name, parts] of outcome.parts) {
            const cell = cells.derived(result, name);
            for (const part of parts) if (emit(cells, cell, part, pos)) changed = true;
            props.set(name, cell);
          }
          if (
            cells.add(result, {
              tag: outcome.tag,
              ctor: "object",
              parts: {
                props: cells.objectParts(props),
                open: false,
                owner: result,
                identity: cells.objectIdentity(result, props),
                written: cells.writtenNames(props),
                made: pos,
              },
              case: `s:${cells.name(result)}`,
              group: outcome.group,
              why,
              pos,
            })
          )
            changed = true;
        } else {
          // every part of a dict (one per written entry, or `element`) goes to its element cell
          const element = cells.derived(result, "element");
          for (const parts of outcome.parts.values())
            for (const part of parts) if (emit(cells, element, part, pos)) changed = true;
          if (
            cells.add(result, {
              tag: outcome.tag,
              ctor: "dict",
              parts: { element },
              case: `s:${cells.name(result)}`,
              group: outcome.group,
              why,
              pos,
            })
          )
            changed = true;
        }
        if (
          outcome.nullable &&
          cells.add(result, { tag: "w", type: cells.table.intern(NULL_TYPE), pos })
        )
          changed = true;
        break;
      }
    }
  }
  return changed;
}

const MEMBER_RELATIONS = new Map<string, OperationRelation>();

/**
 * The relation of a property read on a receiver (`xs.length`, `xs.first`, `t.length`): the member rules decide it per
 * receiver kind, composed over a view's kinds as `methodRelation` composes methods; a held part is read as a
 * projection of the receiver, a kind without the member is invalid unless the receiver may hold data the compiler
 * cannot know, and a dynamic receiver keeps its cases (read as conditional) and adds its provenance. An object's own
 * property cell is read in place beside it.
 */
export function memberRelation(name: string): OperationRelation {
  let relation = MEMBER_RELATIONS.get(name);
  if (relation === undefined) {
    relation = {
      contract: { family: "member", name },
      parameters: NO_PARAMETERS,
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
          receiver.dynamic === null && known.length === 1
            ? known[0]!.result
            : { kind: "byReceiver", cases: known };
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
