import type { CellId, Cells, Item } from "./cells.js";
import { itemAlternatives } from "./lifting.js";
import type { TypeId } from "./types.js";

// The interpretation of a cell's final set (O4 stage 3a, work note §3.2 and §3.5; the executable reference model is
// the contract), computed once after solving and never changing a cell. The order of a cell's known items decides
// its working kind: by the declaration mark, the position (the site in this cell, then the site of the evidence in
// its source), then, where positions tie, the order of the cells the items came from (a copied value keeps its source's working order, a projected part its part's; sources are
// followed recursively, a cell already on the way is not consulted again), then a defined union before a witness at
// the same site, then the name. The first item decides: a witness admits its family (integer with number), a member
// admits every family of its union (Q3.8); every known item of another family is a conflict, kept as the conflict's
// witness. A written bound exports as the bound. Optionality comes from known null items, held from dynamic items
// and from possibilities no witness or member already covers. A cell with no known item and no bound is unknown when
// held, null-only when optional, never otherwise.

export interface CellView {
  readonly kind: "never" | "unknown" | "nullOnly" | "bound" | "known" | "conflict";
  /** What the cell exports: the bound's members, or the working members after numeric widening. */
  readonly members: readonly Member[];
  /** A conflict's families in rank order, the working first; empty otherwise. */
  readonly families: readonly string[];
  readonly optional: boolean;
  readonly held: boolean;
}

/**
 * A member of a cell's view. The structural items of one constructor are **one member** (O1, option B): the
 * collections over their element cells together, the objects as one schema over the union of their property names,
 * each property over the items' part cells for that name together (a conflicting kind is a conflict with the
 * earliest working; a slot no store reached in any item is omitted).
 */
export type Member =
  | { readonly kind: "type"; readonly type: TypeId }
  | {
      readonly kind: "collection";
      readonly ctor: "list" | "set" | "dict";
      readonly element: readonly CellId[];
    }
  | {
      readonly kind: "object";
      readonly props: ReadonlyMap<string, readonly CellId[]>;
      readonly open: boolean;
    };

export interface Working {
  /** The known items in rank order. */
  readonly known: readonly Item[];
  /** The families the working kind admits. */
  readonly admitted: ReadonlySet<string>;
  readonly conflicting: readonly Item[];
  /** Every known family in rank order. */
  readonly order: readonly string[];
}

const NONE = Number.MAX_SAFE_INTEGER;

/** The family of a known item: a constructor, or a scalar's name with number folded into integer (ADR 1.2). */
function familyOf(cells: Cells, item: Item): string {
  if (item.ctor !== undefined) return item.ctor;
  if (item.type === undefined) return item.tag;
  const node = cells.table.node(item.type);
  switch (node.kind) {
    case "atom":
    case "restricted":
      return node.name === "number" ? "integer" : node.name;
    default:
      return node.kind;
  }
}

const isKnown = (item: Item): boolean => item.tag === "w" || item.tag === "m";

/** Whether two items are the same evidence apart from their tags: the same type, or the same structure. */
function sameEvidence(cells: Cells, a: Item, b: Item): boolean {
  if (a.type !== undefined) return a.type === b.type;
  if (a.ctor === undefined || b.ctor !== a.ctor) return false;
  return (
    cells.key({ ...a, tag: "w", group: undefined }) ===
    cells.key({ ...b, tag: "w", group: undefined })
  );
}

/** The known items of a cell in rank order (see the module comment). */
function order(cells: Cells, cell: CellId, visiting: ReadonlySet<CellId>): readonly Item[] {
  return orderItems(cells, cells.items(cell), new Set([...visiting, cell]));
}

/** The known items among `all` in rank order; `inner` the cells on the way, not consulted again as sources. */
function orderItems(
  cells: Cells,
  all: readonly Item[],
  inner: ReadonlySet<CellId>,
): readonly Item[] {
  const items = all.filter(isKnown);
  // an item without a source (a store's own value, an operation's closed answer) is its own first evidence at its
  // position: rank 0, so the secondary site decides between it and an item first in its source (r10-B3)
  const sourceRank = (item: Item): number => {
    let best = NONE;
    for (const source of item.from) {
      if (inner.has(source)) continue;
      const index = order(cells, source, inner).findIndex((other) =>
        sameEvidence(cells, other, item),
      );
      if (index >= 0 && index < best) best = index;
    }
    return best === NONE ? 0 : best;
  };
  // the source's own order before the secondary site: a copied value keeps its source's working kind (its
  // declaration's priority included) through any number of copies and projections (r10-B3)
  const rank = (item: Item): readonly [number, number, number, number, number, string, string] => [
    item.decl ? 0 : 1,
    item.pos[0],
    sourceRank(item),
    item.pos[1],
    item.tag === "m" ? 0 : 1,
    item.tag === "m" ? (item.group ?? "") : "",
    familyOf(cells, item),
  ];
  const ranks = new Map(items.map((item) => [item, rank(item)] as const));
  return [...items].sort((a, b) => {
    const x = ranks.get(a)!;
    const y = ranks.get(b)!;
    for (let k = 0; k < x.length; k += 1) {
      const u = x[k]!;
      const v = y[k]!;
      if (u !== v) return u < v ? -1 : 1;
    }
    return 0;
  });
}

/** The working kind of a cell, or `null` without a known item. */
function working(cells: Cells, cell: CellId): Working | null {
  return workingItems(cells, cells.items(cell), new Set([cell]));
}

function workingItems(
  cells: Cells,
  all: readonly Item[],
  inner: ReadonlySet<CellId>,
): Working | null {
  const known = orderItems(cells, all, inner);
  if (known.length === 0) return null;
  const first = known[0]!;
  const admitted = new Set(
    first.tag === "m"
      ? known
          .filter((item) => item.tag === "m" && item.group === first.group)
          .map((item) => familyOf(cells, item))
      : [familyOf(cells, first)],
  );
  const conflicting = known.filter((item) => !admitted.has(familyOf(cells, item)));
  const families = [...new Set(known.map((item) => familyOf(cells, item)))];
  return { known, admitted, conflicting, order: families };
}

/** The non-working alternatives of every conflicting cell, as `<cell>:<type>`, for the cascade rule of the lifting. */
export function nonWorking(cells: Cells): ReadonlySet<string> {
  const out = new Set<string>();
  for (const cell of cells.ids()) {
    const w = working(cells, cell);
    if (w === null || w.conflicting.length === 0) continue;
    for (const item of w.conflicting)
      for (const alternative of itemAlternatives(cells, item, cell, new Set()))
        out.add(`${cell}:${alternative.type}`);
  }
  return out;
}

/**
 * The members of the items: each flat type once; the witnesses of one constructor as one member (two literals of one
 * place are one schema, option B); a written bound's or a permitted union's structural member as its own (the author
 * wrote `integer[] | string set`, two collections).
 */
function membersOf(cells: Cells, items: readonly Item[]): readonly Member[] {
  const out: Member[] = [];
  const seen = new Set<string>();
  const byCtor = new Map<string, Item[]>();
  for (const item of items) {
    if (item.type !== undefined) {
      const key = `t${item.type}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ kind: "type", type: item.type });
      }
      continue;
    }
    if (item.ctor === undefined || item.parts === undefined) continue;
    if (item.tag === "w") {
      byCtor.set(item.ctor, [...(byCtor.get(item.ctor) ?? []), item]);
      continue;
    }
    const key = cells.key({ ...item, tag: "w", group: undefined });
    if (seen.has(key)) continue;
    seen.add(key);
    byCtor.set(key, [item]);
  }
  // a witness collection over a part empty by construction says nothing beside another member of its constructor
  const emptyWitness = (group: readonly Item[]): boolean =>
    group.every(
      (item) =>
        item.tag === "w" &&
        item.ctor !== "object" &&
        cells.partsOf(item).every((part) => emptyPart(cells, part)),
    );
  const groups = [...byCtor.values()].filter(
    (group) =>
      !(
        emptyWitness(group) &&
        [...byCtor.values()].some((other) => other !== group && other[0]!.ctor === group[0]!.ctor)
      ),
  );
  for (const group of groups) {
    const ctor = group[0]!.ctor!;
    if (ctor === "object") {
      if (group.some((item) => item.parts?.open === true)) {
        out.push({ kind: "object", props: new Map(), open: true });
        continue;
      }
      const props = new Map<string, CellId[]>();
      for (const item of group)
        for (const [name, part] of item.parts!.props!)
          props.set(name, [...new Set([...(props.get(name) ?? []), part])]);
      // a slot no store reached in any item is not a property of the schema
      for (const [name, parts] of [...props])
        if (parts.every((part) => emptyPart(cells, part))) props.delete(name);
      out.push({ kind: "object", props, open: false });
      continue;
    }
    const element = [...new Set(group.map((item) => item.parts!.element!))];
    out.push({ kind: "collection", ctor, element });
  }
  return out;
}

/** Whether a part cell holds nothing, or nothing but the empty-by-construction mark. */
function emptyPart(cells: Cells, cell: CellId): boolean {
  return cells.items(cell).every((item) => item.tag === "e");
}

/** Whether a known item covers a possibility: the same type, or the same constructor part by part. */
function covers(cells: Cells, known: Item, possible: Item, visiting: Set<string>): boolean {
  if (possible.type !== undefined) return known.type === possible.type;
  if (known.ctor === undefined || known.ctor !== possible.ctor) return false;
  if (possible.parts?.props !== undefined) {
    if (possible.parts.open === true) return known.parts?.open === true;
    if (known.parts?.props === undefined || known.parts.open === true) return false;
    for (const [name, part] of possible.parts.props) {
      const other = known.parts.props.get(name);
      if (other === undefined || !partCovers(cells, other, part, visiting)) return false;
    }
    return true;
  }
  if (possible.parts?.element === undefined || known.parts?.element === undefined) return false;
  return partCovers(cells, known.parts.element, possible.parts.element, visiting);
}

function partCovers(cells: Cells, known: CellId, possible: CellId, visiting: Set<string>): boolean {
  if (known === possible) return true;
  const key = `${known}|${possible}`;
  if (visiting.has(key)) return true;
  visiting.add(key);
  const theirs = cells.items(known);
  return cells
    .items(possible)
    .every((item) =>
      item.tag === "e"
        ? theirs.some((other) => other.tag === "e")
        : item.tag === "d" || item.tag === "p"
          ? theirs.some((other) => other.tag === "d" || other.tag === "p")
          : theirs.some(
              (other) =>
                (isKnown(other) || other.tag === "b") && covers(cells, other, item, visiting),
            ),
    );
}

export function interpret(cells: Cells, cell: CellId): CellView {
  return interpretItems(cells, cells.items(cell), [cell]);
}

/** The view of the items of several cells read together (the merged part cells of a structure's property or element). */
export function interpretCells(cells: Cells, group: readonly CellId[]): CellView {
  return interpretItems(
    cells,
    group.flatMap((cell) => cells.items(cell)),
    group,
  );
}

function interpretItems(cells: Cells, items: readonly Item[], group: readonly CellId[]): CellView {
  const table = cells.table;
  const inner = new Set(group);
  const optional = items.some(
    (item) =>
      item.tag === "n" ||
      (item.tag === "b" && item.type !== undefined && table.node(item.type).kind === "null"),
  );
  const bound = items.filter((item) => item.tag === "b");
  // held: a value the compiler cannot know, or a possibility no witness, member or bound covers: the same type, or
  // the same constructor with every item of each part covered by an item of the known item's part (coverage reads
  // the cells); the same rule under a written bound (r10-B4)
  const known = items.filter((item) => isKnown(item) || item.tag === "b");
  const held = items.some(
    (item) =>
      item.tag === "d" ||
      (item.tag === "p" && !known.some((k) => covers(cells, k, item, new Set()))),
  );
  if (bound.length > 0)
    return { kind: "bound", members: membersOf(cells, bound), families: [], optional, held };
  const w = workingItems(cells, items, inner);
  if (w === null)
    return {
      kind: held ? "unknown" : optional ? "nullOnly" : "never",
      members: [],
      families: [],
      optional,
      held,
    };
  const exported =
    w.conflicting.length > 0
      ? w.known.filter((item) => w.admitted.has(familyOf(cells, item)))
      : w.known;
  // numeric widening: integer beside number is number
  const isNumber = (item: Item): boolean =>
    item.type !== undefined &&
    (() => {
      const n = table.node(item.type);
      return n.kind === "atom" && n.name === "number";
    })();
  const isInteger = (item: Item): boolean =>
    item.type !== undefined &&
    (() => {
      const n = table.node(item.type);
      return n.kind === "atom" && n.name === "integer";
    })();
  const widened =
    exported.some(isNumber) && exported.some(isInteger)
      ? exported.filter((item) => !isInteger(item))
      : exported;
  return {
    kind: w.conflicting.length > 0 ? "conflict" : "known",
    members: membersOf(cells, widened),
    families: w.conflicting.length > 0 ? w.order : [],
    optional,
    held,
  };
}
