import type { CellId, Cells, Item } from "./cells.js";
import { itemAlternatives } from "./lifting.js";
import type { TypeId } from "./types.js";

// The interpretation of a cell's final set (O4 stage 3a, work note §3.2 and §3.5; the executable reference model is
// the contract), computed once after solving and never changing a cell. The working kind is decided by the first
// known item by (declaration mark, position, a defined union before a witness at the same site, name): a witness
// admits its family (integer with number), a member admits every family of its union (Q3.8); every known item of
// another family is a conflict, kept as the conflict's witness. A written bound exports as the bound. Optionality
// comes from known null items, held from dynamic items and from possibilities no witness or member already covers.
// A cell with no known item and no bound is unknown when held, null-only when optional, never otherwise.

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
  | { readonly kind: "object"; readonly props: ReadonlyMap<string, CellId> };

export interface Working {
  readonly known: readonly Item[];
  /** The families the working kind admits. */
  readonly admitted: ReadonlySet<string>;
  readonly conflicting: readonly Item[];
  /** Every known family in rank order. */
  readonly order: readonly string[];
}

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

/** The working kind of a cell's known items, or `null` without any. */
function working(cells: Cells, items: readonly Item[]): Working | null {
  const known = items.filter(isKnown);
  if (known.length === 0) return null;
  const rank = (item: Item): readonly [number, number, number, number, string, string] => [
    item.decl ? 0 : 1,
    item.pos[0],
    item.pos[1],
    item.tag === "m" ? 0 : 1,
    item.tag === "m" ? (item.group ?? "") : "",
    familyOf(cells, item),
  ];
  const compare = (a: Item, b: Item): number => {
    const x = rank(a);
    const y = rank(b);
    for (let k = 0; k < x.length; k += 1) {
      const u = x[k]!;
      const v = y[k]!;
      if (u !== v) return u < v ? -1 : 1;
    }
    return 0;
  };
  const sorted = [...known].sort(compare);
  const first = sorted[0]!;
  const admitted = new Set(
    first.tag === "m"
      ? known
          .filter((item) => item.tag === "m" && item.group === first.group)
          .map((item) => familyOf(cells, item))
      : [familyOf(cells, first)],
  );
  const conflicting = known.filter((item) => !admitted.has(familyOf(cells, item)));
  const order = [...new Set(sorted.map((item) => familyOf(cells, item)))];
  return { known, admitted, conflicting, order };
}

/** The non-working alternatives of every conflicting cell, as `<cell>:<type>`, for the cascade rule of the lifting. */
export function nonWorking(cells: Cells): ReadonlySet<string> {
  const out = new Set<string>();
  for (const cell of cells.ids()) {
    const w = working(cells, cells.items(cell));
    if (w === null || w.conflicting.length === 0) continue;
    for (const item of w.conflicting)
      for (const alternative of itemAlternatives(cells, item, 0))
        out.add(`${cell}:${alternative.type}`);
  }
  return out;
}

function memberOf(item: Item): Member {
  if (item.type !== undefined) return { kind: "type", type: item.type };
  if (item.parts?.props !== undefined) return { kind: "object", props: item.parts.props };
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
  const w = working(cells, items);
  // held: a value the compiler cannot know, or a possibility no witness or member covers (every alternative of it
  // is an alternative of a known item)
  const covered = new Set(
    items.filter(isKnown).flatMap((item) => itemAlternatives(cells, item, 0).map((a) => a.type)),
  );
  const held = items.some(
    (item) =>
      item.tag === "d" ||
      (item.tag === "p" && !itemAlternatives(cells, item, 0).every((a) => covered.has(a.type))),
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
  // numeric widening: integer beside number is number; a constructor over a part empty by construction is covered by
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
  const members = dedupe(pruned.map(memberOf));
  return {
    kind: w.conflicting.length > 0 ? "conflict" : "known",
    members,
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
          : `o${[...member.props].map(([name, part]) => `${name}:${part}`).join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(member);
  }
  return out;
}
