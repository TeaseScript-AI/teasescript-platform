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
import type { TypeId, TypeNode } from "./types.js";

// The lifting of a relation's answers into cells (O4 stage 3a, work note §3.5; the executable reference model is the
// contract). An operand's alternatives are one per flat item, one per alternative of the element of a collection item
// (nesting one part at a time: a part empty by construction is `never`, a part with dynamic evidence is also the
// legacy's `unknown`, a part already on the path, a structural cycle, is `unknown`, all permanently; a part without
// evidence contributes nothing yet), and **one** per object item: its shape, every slot with the placeholder `never`,
// which no relation reads (a property's type is read as a leaf, O1). The sets only grow. The relation is asked when
// every strict operand has evidence, over one product of choices: each operand chooses a closed alternative, a
// possibility, a dynamic view (one per provenance: its alternatives and possibilities beside the provenance), or, when
// lazy (a `default:`, the right side of `and` and `or`), nothing. Beyond the operands, the dimensions a relation reads
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
  const own = `${a.tag}|${a.group ?? ""}|${a.why ?? ""}`;
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
  const out = new Map<string, Alternative>();
  for (const item of cells.items(cell)) {
    if (item.tag === "d" || item.tag === "e") continue;
    for (const alternative of itemAlternatives(cells, item, cell, path)) {
      const key = keyOf(alternative);
      const prior = out.get(key);
      if (prior === undefined) out.set(key, alternative);
      else out.set(key, merged(prior, alternative));
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
  return { ...prior, cells, items, choice };
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
  const base = { tag, group: item.group, why: item.why, cells: [cell], items: [item] };
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
  });
  const partAlternatives = (part: CellId): Alternative[] => {
    if (path.has(part) || part === cell) return [synthetic(UNKNOWN_TYPE, part)];
    const out = [...alternatives(cells, part, inner)];
    const items = cells.items(part);
    if (items.some((it) => it.tag === "e")) out.push(synthetic({ kind: "never" }, part));
    if (items.some((it) => it.tag === "d" || it.tag === "p"))
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
    // one alternative: the shape, every slot with the placeholder `never` that no relation reads (a property's type
    // is read as a leaf, one alternative per ask); the shape of an item never changes, so the set only grows and two
    // items of one shape are one alternative whose part cells are read together
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
    return [
      {
        ...base,
        type: table.intern({
          kind: "object",
          properties: new PropertyTable([...props.keys()].map((name) => [name, { kind: "never" }])),
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
}

/** The counted combinations of one operation: cascades are not counted at all. */
export interface Tally {
  readonly asked: number;
  readonly invalid: number;
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
    };

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
       * The result's element cell: `element` for a witness (the witnesses of one constructor are one schema), its own
       * per chosen receiver alternative for a member of a permitted union (its members stay their own, r4-B3 Sol).
       */
      readonly part: string;
    };

interface Reading {
  readonly base: "w" | "m" | "p";
  readonly site: string;
  /** The provenances of the combination's dynamic views and possibilities, for a possibility without one of its own. */
  readonly whys: readonly Provenance[];
  readonly mode: "closed" | "dynamic" | "possible";
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
  return cells
    .items(cell)
    .filter((it) => it.tag === "d" && it.why !== undefined)
    .map((it): DynamicMark => ({ tag: "d", why: it.why! }));
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
  return { base, site, whys, mode };
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
  const choices = operands.map((operand) => picksOf(cells, operand.cell, operand.lazy));
  if (choices.some((list) => list.length === 0)) return { changed: false, tally: null };
  const product = (lists: readonly (readonly Pick[])[]): Pick[][] =>
    lists.reduce<Pick[][]>(
      (acc, list) => acc.flatMap((combo) => list.map((pick) => [...combo, pick])),
      [[]],
    );
  let changed = false;
  let asked = 0;
  let invalid = 0;
  for (const combo of product(choices)) {
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
  const run = (selected: Selection): void => {
    // the first dimension read before its selection, recorded by the closures below
    const wanted: { current: { readonly key: string; readonly picks: readonly Pick[] } | null } = {
      current: null,
    };
    const want: Want = (key, picks) => {
      if (wanted.current === null) wanted.current = { key, picks: picks() };
    };
    const inputs = inputsOf(cells, operands, combo, operation, selected, want);
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
  const placePick = (place: PlaceId): Pick | null =>
    select(`p:${place}`, () => picksOf(cells, place, false), selection, want);
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
    leaf(path) {
      let key: string;
      let dynamicWalk = false;
      let found: readonly (Alternative | DynamicMark)[];
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
        if (pick.kind === "dynamic") {
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
          if (found.every((a) => a.tag !== "d") && parts.length === 0) return null;
          absence = parts.some((part) => cells.items(part).some((it) => it.tag === "e"));
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
): { readonly outcomes: readonly Outcome[]; readonly invalid: boolean } {
  const { cells } = context;
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
          kind: "type",
          tag,
          type: table.intern(a.type),
          group: tag === "m" ? reading.site : undefined,
          why: undefined,
          whys: reading.whys,
          from: [],
          site: undefined,
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
        // a member's rebuilt collection keeps its own element cell, named by the chosen receiver alternative
        const receiverIndex = operands.findIndex((operand) => "receiver" in operand.ref);
        const receiverPick = receiverIndex < 0 ? undefined : combo[receiverIndex];
        const part =
          tag === "m" && receiverPick !== undefined && receiverPick.kind === "closed"
            ? `element#${receiverPick.alt.type}`
            : "element";
        outcomes.push({
          kind: "collection",
          tag,
          ctor: a.constructor,
          elements,
          group: tag === "m" ? reading.site : undefined,
          why: undefined,
          whys: reading.whys,
          part,
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
  return { outcomes, invalid };
}

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
  if (pick.kind !== "closed" && pick.kind !== "possible" && pick.kind !== "dynamic") return [];
  const dynamicWalk = pick.kind === "dynamic";
  const cell = operands[index]!.cell;
  let found: readonly (Alternative | DynamicMark)[] =
    pick.kind === "dynamic" ? [...alternatives(cells, cell), ...marksOf(cells, cell)] : [pick.alt];
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
      const absent = parts.some((part) => cells.items(part).some((it) => it.tag === "e"));
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
    const tag: "w" | "m" | "p" = a.tag === "p" || possible ? "p" : member ? "m" : a.tag;
    const group = tag !== "m" ? undefined : member ? reading.site : a.group;
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
              parts: { props: cells.objectParts(props, result, pos), open: false },
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
