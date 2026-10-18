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

export type Member =
  | { readonly kind: "type"; readonly type: TypeId }
  | {
      readonly kind: "collection";
      readonly ctor: "list" | "set" | "dict";
      readonly element: CellId;
    }
  | {
      readonly kind: "object";
      readonly props: ReadonlyMap<string, CellId>;
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
  const items = cells.items(cell).filter(isKnown);
  const inner = new Set([...visiting, cell]);
  const sourceRank = (item: Item): number => {
    let best = NONE;
    for (const source of item.from) {
      if (inner.has(source)) continue;
      const index = order(cells, source, inner).findIndex((other) =>
        sameEvidence(cells, other, item),
      );
      if (index >= 0 && index < best) best = index;
    }
    return best;
  };
  const rank = (item: Item): readonly [number, number, number, number, number, string, string] => [
    item.decl ? 0 : 1,
    item.pos[0],
    item.pos[1],
    sourceRank(item),
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
  const known = order(cells, cell, new Set());
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

function memberOf(item: Item): Member {
  if (item.type !== undefined) return { kind: "type", type: item.type };
  if (item.parts?.props !== undefined)
    return { kind: "object", props: item.parts.props, open: item.parts.open === true };
  const ctor = item.ctor === "object" || item.ctor === undefined ? "list" : item.ctor;
  return { kind: "collection", ctor, element: item.parts!.element };
}

/** Whether a part cell holds nothing, or nothing but the empty-by-construction mark. */
function emptyPart(cells: Cells, cell: CellId): boolean {
  return cells.items(cell).every((item) => item.tag === "e");
}

export function interpret(cells: Cells, cell: CellId): CellView {
  const items = cells.items(cell);
  const table = cells.table;
  const optional = items.some(
    (item) =>
      item.tag === "n" ||
      (item.tag === "b" && item.type !== undefined && table.node(item.type).kind === "null"),
  );
  const bound = items.filter((item) => item.tag === "b");
  if (bound.length > 0)
    return {
      kind: "bound",
      members: bound.map(memberOf),
      families: [],
      optional,
      held: items.some((item) => item.tag === "d" || item.tag === "p"),
    };
  const w = working(cells, cell);
  // held: a value the compiler cannot know, or a possibility no witness or member covers (every alternative of it
  // is an alternative of a known item)
  const covered = new Set(
    items
      .filter(isKnown)
      .flatMap((item) => itemAlternatives(cells, item, cell, new Set()).map((a) => a.type)),
  );
  const held = items.some(
    (item) =>
      item.tag === "d" ||
      (item.tag === "p" &&
        !itemAlternatives(cells, item, cell, new Set()).every((a) => covered.has(a.type))),
  );
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
  // numeric widening: integer beside number is number; a collection over a part empty by construction is covered by
  // another item of the same constructor
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
  const pruned = widened.filter(
    (item) =>
      !(
        item.ctor !== undefined &&
        item.ctor !== "object" &&
        cells.partsOf(item).every((part) => emptyPart(cells, part)) &&
        widened.some(
          (other) =>
            other !== item &&
            other.ctor === item.ctor &&
            !cells.partsOf(other).every((part) => emptyPart(cells, part)),
        )
      ),
  );
  return {
    kind: w.conflicting.length > 0 ? "conflict" : "known",
    members: dedupe(pruned.map(memberOf)),
    families: w.conflicting.length > 0 ? w.order : [],
    optional,
    held,
  };
}

function dedupe(members: readonly Member[]): readonly Member[] {
  const seen = new Set<string>();
  const out: Member[] = [];
  for (const member of members) {
    const key =
      member.kind === "type"
        ? `t${member.type}`
        : member.kind === "collection"
          ? `${member.ctor}${member.element}`
          : `o${member.open ? "*" : ""}${[...member.props].map(([name, part]) => `${name}:${part}`).join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(member);
  }
  return out;
}
