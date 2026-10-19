import type { DynamicWhy, SourceSite } from "../graph.js";
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
// scheduler's readers of a place see a change anywhere under it. An object item's slots are its own (N-B2): its
// literal's properties and the names a projection reads or stores on it, created on first use (`slot`) and empty by
// construction until a store reaches it (`e`), so a property store through a projected target reaches the object in
// place; a name some store gives objects reads as `maybe absent` where an object lacks the slot (`stored`), a name no
// store gives anywhere as certainly absent; a written bare `object` is an open object item.

export type CellId = number;
export type Tag = "w" | "m" | "b" | "n" | "p" | "d" | "e";
export type Constructor = "list" | "set" | "dict" | "object";
/** The site in this cell, then the site in the source the evidence was copied from. */
export type Position = readonly [number, number];
export type Parts =
  | {
      readonly element: CellId;
      readonly props?: undefined;
      readonly open?: undefined;
      readonly owner?: undefined;
      readonly identity?: undefined;
      readonly written?: undefined;
      readonly made?: undefined;
    }
  | {
      /** The object's own slots: its literal's properties and the names a projection read or stored on it. */
      readonly props: Map<string, CellId>;
      readonly open: boolean;
      /** The cell the object was made in: the owner of its slots' derived cells. */
      readonly owner: CellId;
      /** The object's identity: its owner and the names its literal wrote, never the slots gained later. */
      readonly identity: string;
      /** The names the literal wrote, sorted: with every stored name, the object's shape for the alternatives. */
      readonly written: readonly string[];
      /** The object's creation position: a slot created later carries it, whichever copy touched the slot first. */
      readonly made: Position;
      readonly element?: undefined;
    };
/** The provenance of a `d` or `p` item: the graph's reasons, or the legacy's `unknown` type met in an answer. */
/** Why a value is one the compiler cannot know; `too complex` marks what the budget cut (`budget.ts`). */
export type Provenance = DynamicWhy | "unknown" | "too complex";

export interface Item {
  readonly tag: Tag;
  readonly type: TypeId | undefined;
  readonly ctor: Constructor | undefined;
  readonly parts: Parts | undefined;
  /**
   * The case of a structural item (work note §3.5, I1): the static identity of the structure it is a part of, from a
   * universe fixed by the graph: a written member or a literal by its origin and cell (`written:8@8/1`, `has@31@5`),
   * a structure materialized from a type at a cell by the cell (`c:@44`), a form's structure by its result (`s:@44`),
   * a rebuilt collection by the set of base cases it is built from (`j{...}`, a set, never a sequence). An identity,
   * not support: a copy or a projection carries it; the cells an item was read from are `from`.
   */
  readonly case: string | undefined;
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
  readonly case?: string | undefined;
  /** The part a collection type is materialized in (`element{...}` for the case an operation's combination gives it). */
  readonly part?: string | undefined;
  readonly group?: string | undefined;
  readonly why?: Provenance | undefined;
  readonly pos: Position;
  readonly decl?: boolean | undefined;
  readonly from?: readonly CellId[] | undefined;
}

export const positionAt = (site: number): Position => [site, site];

/**
 * A site as one number ordered by the project's file order, then the offset: positions and the identities of defining
 * sites (`get@`, `fallback@`, `op@`) use it, so two files' offsets never collide or outrank each other.
 */
export const offsetOf = (site: SourceSite): number => site.file * 2 ** 32 + site.start;

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
  #version = 0;

  /** The property names a store in the program gives any object (N-B2): a slot an object lacks for one of them reads as `maybe absent`. */
  readonly #storedNames: ReadonlySet<string>;
  /** The cells holding an object item, by its parts, so a slot created later knows its owners for the drain closure. */
  readonly #holders = new WeakMap<Parts, Set<CellId>>();
  /** The property entries the alternatives' shapes built (`Solution.work.entries`). */
  #shapeEntries = 0;

  constructor(table: TypeTable, places: number, propertyNames: readonly string[] = []) {
    this.#table = table;
    this.#next = places;
    this.#storedNames = new Set(propertyNames);
    for (let id = 0; id < places; id += 1) this.#cells.set(id, new Map());
  }

  get table(): TypeTable {
    return this.#table;
  }

  /** A counter of every change, so a reader computed over the cells knows when it is stale. */
  get version(): number {
    return this.#version;
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

  /**
   * The derived part cell of a cell: the element of its lists (`element`, or `element{B}` over a set of base cases none
   * of which is itself a rebuilt case), one of its properties, or a written member's index. The grammar is the finite
   * universe of I1: a part outside it is a defect, thrown.
   */
  derived(owner: CellId, part: string): CellId {
    if (
      !/^(element|element\{[^{}]+\}|[A-Za-z_][A-Za-z0-9_]*|\d+)$/.test(part) ||
      (part.startsWith("element{") &&
        part
          .slice(8, -1)
          .split(",")
          .some((b) => b.includes("{")))
    )
      throw new Error(`a part outside the universe: ${this.name(owner)}/${part}`);
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

  /**
   * An object's slots are its own (the external review's N-B2): the properties its literal wrote, and a slot per name
   * a projection reads or stores on it, created on demand (`slot`), empty by construction until a store reaches it;
   * no object carries the program's whole vocabulary.
   */
  objectParts(props: ReadonlyMap<string, CellId>): Map<string, CellId> {
    return new Map(props);
  }

  /** An object's identity: the cell it was made in and the names its literal wrote (never the slots gained later). */
  objectIdentity(owner: CellId, props: ReadonlyMap<string, unknown>): string {
    return `#${owner}{${[...props.keys()].sort().join(",")}}`;
  }

  /**
   * The slot of a property on an object, created on first use with the empty-by-construction mark: a touched cell
   * whose owners are every cell holding the item, so the object's readers re-evaluate. Every copy of the item shares
   * the parts, so the slot is theirs too.
   */
  slot(item: Item, name: string): CellId {
    const props = item.parts!.props!;
    let cell = props.get(name);
    if (cell === undefined) {
      cell = this.derived(item.parts!.owner!, name);
      props.set(name, cell);
      for (const holder of this.#holders.get(item.parts!) ?? []) this.#own(cell, holder);
      this.add(cell, { tag: "e", pos: item.parts!.made! });
    }
    return cell;
  }

  /** Whether a store in the program gives some object the property. */
  stored(name: string): boolean {
    return this.#storedNames.has(name);
  }

  /** The property names a store in the program gives any object. */
  get storedNames(): ReadonlySet<string> {
    return this.#storedNames;
  }

  /** The names an object literal wrote, sorted. */
  writtenNames(props: ReadonlyMap<string, unknown>): readonly string[] {
    return [...props.keys()].sort();
  }

  /**
   * The shape key of a closed object for the alternatives (DC2-B1): its written names outside the stored set, the
   * partition the eager vocabulary shape gave (two objects were one alternative iff their written names agreed up to
   * the stored names); the alternative's type is its own group's slots, never the vocabulary, so the construction is
   * linear in the objects.
   */
  shapeKey(written: readonly string[]): string {
    return `o|${written.filter((name) => !this.#storedNames.has(name)).join(",")}`;
  }

  /** Counts the property entries an alternative's shape built. */
  countShape(entries: number): void {
    this.#shapeEntries += entries;
  }

  get shapeEntries(): number {
    return this.#shapeEntries;
  }

  #own(part: CellId, owner: CellId): void {
    let owners = this.#owners.get(part);
    if (owners === undefined) {
      owners = new Set();
      this.#owners.set(part, owners);
    }
    owners.add(owner);
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
          // the part the combination's cases give it, else the cell's own; its case likewise (I1)
          const element = this.derived(cell, contribution.part ?? "element");
          // a never element: the part is empty by construction
          const changedPart =
            this.#table.node(node.element).kind === "never"
              ? this.add(element, { tag: "e", pos: contribution.pos })
              : // the nested structure keeps the case (a derived cell's name would leave the grammar at the next
                // rebuild: PR 3a review r6, Astra B1)
                this.add(element, { ...contribution, type: node.element, part: undefined });
          const { type: _, part: __, ...rest } = contribution;
          const changed = this.#put(cell, {
            ...rest,
            ctor: node.kind,
            parts: { element },
            case: contribution.case ?? `c:${this.name(cell)}`,
          });
          return changed || changedPart;
        }
        case "object": {
          const { type: _, part: __, ...rest } = contribution;
          if (node.properties === null)
            return this.#put(cell, {
              ...rest,
              ctor: "object",
              parts: {
                props: this.objectParts(new Map()),
                open: true,
                owner: cell,
                identity: this.objectIdentity(cell, new Map()),
                written: [],
                made: contribution.pos,
              },
              case: `c:${this.name(cell)}`,
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
            parts: {
              props: this.objectParts(props),
              open: false,
              owner: cell,
              identity: this.objectIdentity(cell, props),
              written: this.writtenNames(props),
              made: contribution.pos,
            },
            case: `c:${this.name(cell)}`,
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

  /**
   * Marks a cell changed without an item: the fixpoint step's decision that a rebuilt structure merges into the
   * cell's witness structures changes what the stores into the cell do, so their readers and they re-evaluate.
   */
  touch(cell: CellId): void {
    this.#touched.add(cell);
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
            ? `o${item.parts!.open === true ? "*" : ""}${item.parts!.identity}`
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
      case: contribution.ctor === undefined ? undefined : contribution.case,
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
      // one structure, more slots: a relation's later answer with more properties extends the structure's map
      // (shared by every copy), its new slots owned by every holder, so its slots are the union of its answers'
      if (
        item.parts?.props !== undefined &&
        prior.parts?.props !== undefined &&
        item.parts !== prior.parts
      )
        for (const [name, part] of item.parts.props)
          if (!prior.parts.props.has(name)) {
            prior.parts.props.set(name, part);
            for (const holder of this.#holders.get(prior.parts) ?? []) this.#own(part, holder);
            changed = true;
          }
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
      if (changed) {
        this.#touched.add(cell);
        this.#version += 1;
      }
      return changed;
    }
    map.set(key, item);
    this.#version += 1;
    for (const part of this.partsOf(item)) this.#own(part, cell);
    if (item.parts?.props !== undefined) {
      let holders = this.#holders.get(item.parts);
      if (holders === undefined) {
        holders = new Set();
        this.#holders.set(item.parts, holders);
      }
      holders.add(cell);
    }
    this.#touched.add(cell);
    return true;
  }
}
