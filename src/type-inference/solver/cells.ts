import type { DynamicWhy } from "../graph.js";
import type { TypeId, TypeTable } from "./types.js";

// The cells of the solver (O4 stage 3a, work note §3.2; the executable reference model `model/solver-model.mjs` of
// the research folder is the contract): every place of the graph is a cell holding the set of its evidence items, and
// nothing is ever removed from a set. An item is tagged: `w` a witness of one known family, `m` a member of a
// permitted union carrying the union's identity, `b` a written bound, `n` a known null, `p` a possibility with its
// provenance, `d` a value the compiler cannot know with its provenance, `e` a literal part that is empty by
// construction. A flat item holds a type id (an atom, a restricted scalar, null); a structural value is always an
// item with part cells: a literal's own cells, or the derived part cells of the cell that holds a relation's
// structural answer, so that an element or a property is reached in place wherever the value is. An item carries the
// earliest position of its evidence, a pair (the site in this cell, the site in the source it was copied from)
// compared lexicographically, the cells it was copied or projected from at that position (`from`, which the
// interpretation follows where positions tie), and the declaration mark of Q3.1r. The same evidence from two sites
// is one item whose position is the earliest and whose mark is either's; both merges are changes, as a new item is,
// and `drain` reports every changed cell together with every cell that holds an item whose part changed, so the
// scheduler's readers of a place see a change anywhere under it. Every object item carries a slot for every property
// name a store in the program gives any object, empty by construction until a store reaches it (`e`), so a property
// store through a projected target reaches the object in place; a written bare `object` is an open object item.

export type CellId = number;
export type Tag = "w" | "m" | "b" | "n" | "p" | "d" | "e";
export type Constructor = "list" | "set" | "dict" | "object";
/** The site in this cell, then the site in the source the evidence was copied from. */
export type Position = readonly [number, number];
export type Parts =
  | { readonly element: CellId; readonly props?: undefined; readonly open?: undefined }
  | {
      readonly props: ReadonlyMap<string, CellId>;
      readonly open: boolean;
      readonly element?: undefined;
    };
/** The provenance of a `d` or `p` item: the graph's reasons, or the legacy's `unknown` type met in an answer. */
export type Provenance = DynamicWhy | "unknown";

export interface Item {
  readonly tag: Tag;
  readonly type: TypeId | undefined;
  readonly ctor: Constructor | undefined;
  readonly parts: Parts | undefined;
  /** The identity of the permitted union an `m` or `b` item belongs to: a written place or a defining site. */
  readonly group: string | undefined;
  readonly why: Provenance | undefined;
  pos: Position;
  decl: boolean;
  from: Set<CellId>;
}

/** What a transfer adds: the fields of an item, a `type` of any kind (normalized by `add`), position and mark. */
export interface Contribution {
  readonly tag: Tag;
  readonly type?: TypeId | undefined;
  readonly ctor?: Constructor | undefined;
  readonly parts?: Parts | undefined;
  readonly group?: string | undefined;
  readonly why?: Provenance | undefined;
  readonly pos: Position;
  readonly decl?: boolean | undefined;
  readonly from?: readonly CellId[] | undefined;
}

export const positionAt = (site: number): Position => [site, site];

function comparePositions(a: Position, b: Position): number {
  return a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1];
}

export class Cells {
  readonly #table: TypeTable;
  readonly #cells = new Map<CellId, Map<string, Item>>();
  /** Derived cells by name (`<owner>/element`, `<owner>/<property>`), so a part cell is one cell wherever it is asked for. */
  readonly #derived = new Map<string, CellId>();
  readonly #names = new Map<CellId, string>();
  /** The cells that hold an item whose part is the key, for the change closure. */
  readonly #owners = new Map<CellId, Set<CellId>>();
  readonly #touched = new Set<CellId>();
  #next: CellId;

  readonly #propertyNames: readonly string[];

  constructor(table: TypeTable, places: number, propertyNames: readonly string[] = []) {
    this.#table = table;
    this.#next = places;
    this.#propertyNames = propertyNames;
    for (let id = 0; id < places; id += 1) this.#cells.set(id, new Map());
  }

  get table(): TypeTable {
    return this.#table;
  }

  /** Every cell, the places first, then the derived cells in creation order. */
  ids(): readonly CellId[] {
    return [...this.#cells.keys()];
  }

  items(cell: CellId): readonly Item[] {
    return [...this.#cell(cell).values()];
  }

  has(cell: CellId): boolean {
    return this.#cell(cell).size > 0;
  }

  /** The derived part cell of a cell: the element of its lists, or one of its properties. */
  derived(owner: CellId, part: string): CellId {
    const name = `${this.name(owner)}/${part}`;
    let id = this.#derived.get(name);
    if (id === undefined) {
      id = this.#next;
      this.#next += 1;
      this.#derived.set(name, id);
      this.#names.set(id, name);
      this.#cells.set(id, new Map());
    }
    return id;
  }

  /** The name a dump gives the cell: a place's id, or a derived cell's path from its place. */
  name(cell: CellId): string {
    return this.#names.get(cell) ?? `${cell}`;
  }

  /** The part cells of a structural item. */
  partsOf(item: Item): readonly CellId[] {
    if (item.parts === undefined) return [];
    return item.parts.props === undefined ? [item.parts.element] : [...item.parts.props.values()];
  }

  /** The property cells of an object with every stored name's slot, the missing ones empty by construction. */
  objectParts(
    props: ReadonlyMap<string, CellId>,
    owner: CellId,
    pos: Position,
  ): Map<string, CellId> {
    const out = new Map(props);
    for (const name of this.#propertyNames)
      if (!out.has(name)) {
        const slot = this.derived(owner, name);
        this.add(slot, { tag: "e", pos });
        out.set(name, slot);
      }
    return out;
  }

  /**
   * Adds one contribution to a cell and tells whether the cell changed. A type is normalized first: a union's members
   * are members of a permitted union (the contribution's identity, or a fresh one at its site), null is `n`, never is
   * nothing, the legacy's `unknown` is dynamic, and a structural type becomes a structural item whose parts are this
   * cell's derived part cells, each part added recursively.
   */
  add(cell: CellId, contribution: Contribution): boolean {
    const type = contribution.type;
    if (type !== undefined) {
      const node = this.#table.node(type);
      switch (node.kind) {
        case "never":
          return false;
        case "unknown":
          return this.add(cell, { tag: "d", why: "unknown", pos: contribution.pos });
        case "union": {
          const group = contribution.group ?? `u@${contribution.pos[0]}`;
          const tag: Tag =
            contribution.tag === "b" || contribution.tag === "p" || contribution.tag === "d"
              ? contribution.tag
              : "m";
          let changed = false;
          for (const member of node.members)
            if (this.add(cell, { ...contribution, type: member, tag, group })) changed = true;
          return changed;
        }
        case "null":
          if (contribution.tag !== "b" && contribution.tag !== "p")
            return this.#put(cell, { ...contribution, tag: "n", group: undefined });
          return this.#put(cell, contribution);
        case "list":
        case "set":
        case "dict": {
          const element = this.derived(cell, "element");
          // a never element: the part is empty by construction
          const changedPart =
            this.#table.node(node.element).kind === "never"
              ? this.add(element, { tag: "e", pos: contribution.pos })
              : this.add(element, { ...contribution, type: node.element });
          const { type: _, ...rest } = contribution;
          const changed = this.#put(cell, { ...rest, ctor: node.kind, parts: { element } });
          return changed || changedPart;
        }
        case "object": {
          const { type: _, ...rest } = contribution;
          if (node.properties === null)
            return this.#put(cell, {
              ...rest,
              ctor: "object",
              parts: { props: this.objectParts(new Map(), cell, contribution.pos), open: true },
            });
          let changedPart = false;
          const props = new Map<string, CellId>();
          for (const property of node.properties) {
            const part = this.derived(cell, property.name);
            if (this.add(part, { ...contribution, type: property.type })) changedPart = true;
            props.set(property.name, part);
          }
          const changed = this.#put(cell, {
            ...rest,
            ctor: "object",
            parts: { props: this.objectParts(props, cell, contribution.pos), open: false },
          });
          return changed || changedPart;
        }
        case "atom":
        case "restricted":
          return this.#put(cell, contribution);
      }
    }
    return this.#put(cell, contribution);
  }

  /** The cells changed since the last drain, closed over the cells that hold an item with a changed part. */
  drain(): readonly CellId[] {
    const out = new Set<CellId>();
    const work = [...this.#touched];
    this.#touched.clear();
    while (work.length > 0) {
      const cell = work.pop()!;
      if (out.has(cell)) continue;
      out.add(cell);
      for (const owner of this.#owners.get(cell) ?? []) work.push(owner);
    }
    return [...out].sort((a, b) => a - b);
  }

  /** Whether anything changed since the last drain. */
  get dirty(): boolean {
    return this.#touched.size > 0;
  }

  /** The identity of an item in its cell: tag, type or structure, union identity, provenance; never a text of a type. */
  key(item: Contribution | Item): string {
    const structure =
      item.type !== undefined
        ? `t${item.type}`
        : item.ctor === undefined
          ? ""
          : item.ctor === "object"
            ? `o${item.parts!.open === true ? "*" : ""}{${[...item.parts!.props!]
                .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                .map(([name, cell]) => `${name}:${cell}`)
                .join(",")}}`
            : `${item.ctor[0]}${item.parts!.element}`;
    const group = item.tag === "m" || item.tag === "b" ? (item.group ?? "") : "";
    const why = item.tag === "p" || item.tag === "d" ? (item.why ?? "") : "";
    return `${item.tag}|${structure}|${group}|${why}`;
  }

  #cell(cell: CellId): Map<string, Item> {
    let map = this.#cells.get(cell);
    if (map === undefined) {
      map = new Map();
      this.#cells.set(cell, map);
    }
    return map;
  }

  #put(cell: CellId, contribution: Contribution): boolean {
    const item: Item = {
      tag: contribution.tag,
      type: contribution.type,
      ctor: contribution.ctor,
      parts: contribution.parts,
      group: contribution.tag === "m" || contribution.tag === "b" ? contribution.group : undefined,
      why: contribution.tag === "p" || contribution.tag === "d" ? contribution.why : undefined,
      pos: contribution.pos,
      decl: contribution.decl === true,
      from: new Set(contribution.from ?? []),
    };
    const map = this.#cell(cell);
    const key = this.key(item);
    const prior = map.get(key);
    if (prior !== undefined) {
      let changed = false;
      if (item.decl && !prior.decl) {
        prior.decl = true;
        changed = true;
      }
      const order = comparePositions(item.pos, prior.pos);
      if (order < 0) {
        prior.pos = item.pos;
        prior.from = new Set(item.from);
        changed = true;
      } else if (order === 0) for (const source of item.from) prior.from.add(source);
      if (changed) this.#touched.add(cell);
      return changed;
    }
    map.set(key, item);
    for (const part of this.partsOf(item)) {
      let owners = this.#owners.get(part);
      if (owners === undefined) {
        owners = new Set();
        this.#owners.set(part, owners);
      }
      owners.add(cell);
    }
    this.#touched.add(cell);
    return true;
  }
}
