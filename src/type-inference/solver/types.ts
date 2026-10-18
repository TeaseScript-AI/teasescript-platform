import {
  assignedType,
  excludeType,
  isAssignable,
  isScalarKind,
  members as memberTypes,
  narrowTo,
  nonNullType,
  NULL_TYPE,
  optional as optionalType,
  PropertyTable,
  union,
  UNKNOWN_TYPE,
  type ScalarValue,
  type StaticType,
} from "../../static-types.js";
import { VALUE_KINDS, type PlainKind, type ValueKind } from "../../value-kinds.js";
import type { TypeTerm } from "../graph.js";

// The type table of the solver (O4 stage 3a, work note §2): every type the solver handles is a node of one table,
// interned by structure, so that two equal types have one id and identity is an integer comparison. A node holds its
// kind, its names and values, and the ids of its parts; no text, no inference. The table converts both ways with the
// adapters' `StaticType`: `toStatic` builds one object per id with shared structure, `intern` remembers every object it
// converted and otherwise looks the structure up per kind, keyed by the parts' ids and the sorted names and values.
//
// Every transfer converts its arguments with `toStatic`, calls the legacy function of `static-types.ts` (`union`,
// `narrowTo`, `excludeType`, `assignedType`, `isAssignable`, `members`, `optional`, `nonNullType`) and interns its
// answer, remembered per argument tuple, so that the table cannot disagree with the legacy's algebra. Structure is the
// one identity: where the legacy's `union` keeps two equal objects that have property tables (`includes` lets no such
// object include another, so `union([o, o])` is `(o | o)`, also inside `narrowTo` and `assignedType`, which join what
// they keep), the interned union holds the one id. A native transfer is a later performance item (work note §10), only
// if the measurement asks for it.
//
// Admissible inputs are canonical types: those the legacy's constructors and transfers, the annotations and the adapters
// produce, in which every union is the legacy's `union` of its members. `intern` canonicalizes a union it meets through
// that same `union`, so an unnormalized input (`(integer|number)` written by hand, a member another member includes)
// gets the one id of the type it denotes, and no transfer depends on what was interned before; on such an input the
// legacy's own transfer may spell its answer by the input's first member, and the agreement claimed below is about
// canonical inputs. What `toStatic` returns is a borrowed immutable value: a property table's entries stay mutable in
// the legacy's representation, and a consumer that mutates one changes later static views while the nodes and the
// remembered transfers keep their answers; the solver and the export build their own tables for mutable state.
//
// A node does not hold the numeric lineage of a scalar (`origins`), which the export records with the cell, nor the
// legacy's property-table lineage (`PropertyTable.sources`), which the cell model replaces; interning drops both. An
// undecided slot (`open`) and an open property table (`PropertyTable.open`) are facts of a place, not of a type: the
// solver never interns one, and interning one throws. An interned `StaticType` is taken as immutable: a property table
// that grows after it was interned keeps the id of its earlier properties. `toStatic` freezes the objects it builds,
// except a property table's entries, which a `Map` keeps mutable.

export type TypeId = number;

/** The interned node: no inference inside, no text. */
export type TypeNode =
  /** A kind of the registry held without parts: a scalar such as `integer` or `number`, or `range`, `timer`, ... */
  | { readonly kind: "atom"; readonly name: ValueKind }
  | { readonly kind: "never" }
  | { readonly kind: "null" }
  | { readonly kind: "unknown" }
  | { readonly kind: "list" | "set" | "dict"; readonly element: TypeId }
  /** Properties sorted by name; `null` is the written bare `object`. */
  | {
      readonly kind: "object";
      readonly properties: readonly { readonly name: string; readonly type: TypeId }[] | null;
    }
  /** Sorted ids, flattened, at least two. */
  | { readonly kind: "union"; readonly members: readonly TypeId[] }
  /** A scalar that only takes these values, sorted. */
  | {
      readonly kind: "restricted";
      readonly name: ValueKind;
      readonly values: readonly ScalarValue[];
    };

type Key = string | number | boolean;

/** A node of a lookup tree: the id found at the end of a sequence of keys, and the branches for the next key. */
class Branches {
  id: TypeId | undefined = undefined;
  readonly next = new Map<Key, Branches>();
}

function branch(root: Branches, keys: Iterable<Key>): Branches {
  let at = root;
  for (const key of keys) {
    let next = at.next.get(key);
    if (next === undefined) at.next.set(key, (next = new Branches()));
    at = next;
  }
  return at;
}

/**
 * Visits `root` and every part below it, parts first, with an explicit stack: a type nests as deep as the literal or
 * annotation it comes from. `finish` runs once for each part that is not `done` yet, after all of its own parts.
 */
function partsFirst<T>(
  root: T,
  done: (item: T) => boolean,
  parts: (item: T) => readonly T[],
  finish: (item: T) => void,
): void {
  const pending: T[] = [root];
  const entered = new Set<T>();
  while (pending.length > 0) {
    // EVIDENCE: invariant: the loop runs only while `pending` is not empty.
    const top = pending.at(-1)!;
    if (done(top)) {
      pending.pop();
      continue;
    }
    const missing = parts(top).filter((part) => !done(part));
    if (missing.length === 0) {
      finish(top);
      pending.pop();
      continue;
    }
    // Every part pushed for an entered item is done before the item is on top again, unless the item is its own part.
    if (entered.has(top)) throw new Error("A type that contains itself has no interned form.");
    entered.add(top);
    for (const part of missing) pending.push(part);
  }
}

function staticParts(type: StaticType): readonly StaticType[] {
  switch (type.kind) {
    case "list":
    case "set":
    case "dict":
      return [type.element];
    case "object":
      return type.properties === null ? [] : [...type.properties.values()];
    case "union":
      return type.members;
    default:
      return [];
  }
}

function termParts(term: TypeTerm): readonly TypeTerm[] {
  switch (term.kind) {
    case "list":
    case "set":
    case "dict":
      return [term.element];
    case "object":
      return term.properties === null ? [] : term.properties.map((property) => property.type);
    case "union":
      return term.members;
    default:
      return [];
  }
}

function nodeParts(node: TypeNode): readonly TypeId[] {
  switch (node.kind) {
    case "list":
    case "set":
    case "dict":
      return [node.element];
    case "object":
      return node.properties === null ? [] : node.properties.map((property) => property.type);
    case "union":
      return node.members;
    default:
      return [];
  }
}

/** Whether the compiler holds a type of `kind` as a type of its own name without parts, such as `range`. */
function isPlainKind(kind: ValueKind): kind is Exclude<PlainKind, "null"> {
  return VALUE_KINDS[kind].type === "kind" && kind !== "null";
}

/** The values in one canonical order, each once: booleans, then numbers, then strings. */
function sortedValues(values: readonly ScalarValue[]): readonly ScalarValue[] {
  const rank = (value: ScalarValue): number =>
    typeof value === "boolean" ? 0 : typeof value === "number" ? 1 : 2;
  const sorted = [...values].sort((left, right) => {
    if (rank(left) !== rank(right)) return rank(left) - rank(right);
    if (typeof left === "string" && typeof right === "string")
      return left < right ? -1 : left > right ? 1 : 0;
    return Number(left) - Number(right);
  });
  return sorted.filter((value, index) => index === 0 || value !== sorted[index - 1]);
}

function rememberedPair<T extends TypeId | boolean>(
  memo: Map<TypeId, Map<TypeId, T>>,
  left: TypeId,
  right: TypeId,
  compute: () => T,
): T {
  let row = memo.get(left);
  if (row === undefined) memo.set(left, (row = new Map<TypeId, T>()));
  const known = row.get(right);
  if (known !== undefined) return known;
  const value = compute();
  row.set(right, value);
  return value;
}

function remembered<T>(memo: Map<TypeId, T>, id: TypeId, compute: () => T): T {
  const known = memo.get(id);
  if (known !== undefined) return known;
  const value = compute();
  memo.set(id, value);
  return value;
}

const NEVER_STATIC: StaticType = Object.freeze({ kind: "never" });

/** The interned types of one solve, and the legacy's transfers over their ids. */
export class TypeTable {
  readonly #nodes: TypeNode[] = [];
  /** The `StaticType` of each id, built on demand. */
  readonly #statics: (StaticType | undefined)[] = [];
  /** The id of each `StaticType` object interned or built, so that a converted object is found without a lookup. */
  readonly #ids = new WeakMap<StaticType, TypeId>();
  readonly #termIds = new WeakMap<TypeTerm, TypeId>();

  readonly #never: TypeId;
  readonly #null: TypeId;
  readonly #unknown: TypeId;
  readonly #anyObject: TypeId;
  readonly #atoms = new Branches();
  readonly #restricted = new Branches();
  readonly #collections = new Branches();
  readonly #objects = new Branches();
  readonly #unions = new Branches();

  readonly #alternatives = new Branches();
  readonly #narrowed = new Map<TypeId, Map<TypeId, TypeId>>();
  readonly #excluded = new Map<TypeId, Map<TypeId, TypeId>>();
  readonly #assigned = new Map<TypeId, Map<TypeId, TypeId>>();
  readonly #fits = new Map<TypeId, Map<TypeId, boolean>>();
  readonly #members = new Map<TypeId, readonly TypeId[]>();
  readonly #optional = new Map<TypeId, TypeId>();
  readonly #nonNull = new Map<TypeId, TypeId>();

  constructor() {
    this.#never = this.#add({ kind: "never" });
    this.#null = this.#add({ kind: "null" });
    this.#unknown = this.#add({ kind: "unknown" });
    this.#anyObject = this.#add({ kind: "object", properties: null });
  }

  /** The id of a type: equal structure, one id. */
  intern(type: StaticType): TypeId {
    partsFirst(
      type,
      (part) => this.#ids.has(part),
      (part) => {
        if (part.kind === "open") throw new Error("The solver never interns an undecided slot.");
        return staticParts(part);
      },
      (part) => this.#ids.set(part, this.#internStatic(part)),
    );
    // EVIDENCE: invariant: `partsFirst` finished `type` or found it done.
    return this.#ids.get(type)!;
  }

  /**
   * The id of a term of the graph. A union term is the legacy's union of its members, as `typeFromAnnotation` makes a
   * written union, so `integer | number` is `number`. A `dynamic` term is `unknown`: provenance lives in the cell, not
   * in the type. A `ref` term throws: the solver resolves refs.
   */
  internTerm(term: TypeTerm): TypeId {
    partsFirst(
      term,
      (part) => this.#termIds.has(part),
      termParts,
      (part) => this.#termIds.set(part, this.#internTermNode(part)),
    );
    // EVIDENCE: invariant: `partsFirst` finished `term` or found it done.
    return this.#termIds.get(term)!;
  }

  /** The `StaticType` of an id: one object per id, sharing the objects of its parts. */
  toStatic(id: TypeId): StaticType {
    partsFirst(
      id,
      (part) => this.#statics[part] !== undefined,
      (part) => nodeParts(this.node(part)),
      (part) => {
        const type = this.#buildStatic(part);
        this.#statics[part] = type;
        this.#ids.set(type, part);
      },
    );
    // EVIDENCE: invariant: `partsFirst` finished `id` or found it done.
    return this.#statics[id]!;
  }

  node(id: TypeId): TypeNode {
    const node = this.#nodes[id];
    if (node === undefined) throw new Error(`No type has the id ${id}.`);
    return node;
  }

  /** The flow merge (`Flow.join`): the legacy's `union` of the alternatives, flattened, without never, canonical. */
  alternatives(ids: readonly TypeId[]): TypeId {
    const end = branch(this.#alternatives, ids);
    return (end.id ??= this.intern(union(ids.map((id) => this.toStatic(id)))));
  }

  /** What a value of `id` is when it passes the test `is test` (`narrowTo`). */
  narrow(id: TypeId, test: TypeId): TypeId {
    return rememberedPair(this.#narrowed, id, test, () =>
      this.intern(narrowTo(this.toStatic(id), this.toStatic(test))),
    );
  }

  /** What a value of `id` is when it fails the test `is test` (`excludeType`). */
  exclude(id: TypeId, test: TypeId): TypeId {
    return rememberedPair(this.#excluded, id, test, () =>
      this.intern(excludeType(this.toStatic(id), this.toStatic(test))),
    );
  }

  /** What a place of type `declared` holds directly after a value of type `value` is stored (`assignedType`). */
  assigned(declared: TypeId, value: TypeId): TypeId {
    return rememberedPair(this.#assigned, declared, value, () =>
      this.intern(assignedType(this.toStatic(declared), this.toStatic(value))),
    );
  }

  /** Whether a value of `source` may be stored where `target` is required (`isAssignable`). */
  fits(target: TypeId, source: TypeId): boolean {
    return rememberedPair(this.#fits, target, source, () =>
      isAssignable(this.toStatic(target), this.toStatic(source)),
    );
  }

  /** The members of the legacy's canonical form of the type, or the type itself (`members`). */
  members(id: TypeId): readonly TypeId[] {
    return remembered(this.#members, id, () =>
      Object.freeze(memberTypes(this.toStatic(id)).map((member) => this.intern(member))),
    );
  }

  /** `T?` (`optional`). */
  optional(id: TypeId): TypeId {
    return remembered(this.#optional, id, () => this.intern(optionalType(this.toStatic(id))));
  }

  /** The type without `null` (`nonNullType`). */
  nonNull(id: TypeId): TypeId {
    return remembered(this.#nonNull, id, () => this.intern(nonNullType(this.toStatic(id))));
  }

  #add(node: TypeNode): TypeId {
    this.#nodes.push(Object.freeze(node));
    return this.#nodes.length - 1;
  }

  /** The id of a type whose parts are interned already. */
  #internStatic(type: StaticType): TypeId {
    switch (type.kind) {
      case "unknown":
        return this.#unknown;
      case "never":
        return this.#never;
      case "null":
        return this.#null;
      case "scalar":
        return type.values === undefined
          ? this.#atom(type.name)
          : this.#restrictedType(type.name, type.values);
      case "list":
      case "set":
      case "dict":
        return this.#collection(type.kind, this.#idOf(type.element));
      case "object": {
        if (type.properties === null) return this.#anyObject;
        if (type.properties.open)
          throw new Error(
            "An open property table is a fact of a place: the solver never interns one.",
          );
        const properties: { readonly name: string; readonly type: TypeId }[] = [];
        for (const [name, value] of type.properties)
          properties.push({ name, type: this.#idOf(value) });
        return this.#object(properties);
      }
      case "union": {
        // The canonical form is the legacy's own: `union` of the members, each already interned and so canonical, drops
        // a member another includes and makes `integer | number` a number. An unnormalized input (a union a producer
        // built by hand) therefore interns as the type it denotes, one id with its normalized spelling, whatever was
        // interned before; the legacy's answer for such an input keeps its first spelling instead, which is outside the
        // admissible inputs (see the module comment).
        const canonical = union(type.members.map((member) => this.toStatic(this.#idOf(member))));
        if (canonical.kind !== "union") return this.intern(canonical);
        return this.#union(canonical.members.map((member) => this.intern(member)));
      }
      case "open":
        throw new Error("The solver never interns an undecided slot.");
      default:
        return this.#atom(type.kind);
    }
  }

  #idOf(type: StaticType): TypeId {
    const id = this.#ids.get(type);
    if (id === undefined) throw new Error("A part of the type was not interned first.");
    return id;
  }

  /** The id of a term whose parts are interned already. */
  #internTermNode(term: TypeTerm): TypeId {
    switch (term.kind) {
      case "atom":
        if (term.name === "null") return this.#null;
        if (!isScalarKind(term.name) && !isPlainKind(term.name))
          throw new Error(`A term writes the kind '${term.name}' with its parts, not as an atom.`);
        return this.#atom(term.name);
      case "never":
        return this.#never;
      case "dynamic":
        return this.#unknown;
      case "list":
      case "set":
      case "dict":
        return this.#collection(term.kind, this.#termIdOf(term.element));
      case "object": {
        if (term.properties === null) return this.#anyObject;
        const names = new Set(term.properties.map((property) => property.name));
        if (names.size !== term.properties.length)
          throw new Error("An object term names a property twice.");
        return this.#object(
          term.properties.map((property) => ({
            name: property.name,
            type: this.#termIdOf(property.type),
          })),
        );
      }
      case "union":
        return this.alternatives(term.members.map((member) => this.#termIdOf(member)));
      case "restricted":
        if (!isScalarKind(term.name))
          throw new Error(`Only a scalar kind takes restricted values, not '${term.name}'.`);
        return this.#restrictedType(term.name, term.values);
      case "ref":
        throw new Error("The solver resolves a ref term to its place's type before interning.");
    }
  }

  #termIdOf(term: TypeTerm): TypeId {
    const id = this.#termIds.get(term);
    if (id === undefined) throw new Error("A part of the term was not interned first.");
    return id;
  }

  #atom(name: ValueKind): TypeId {
    const end = branch(this.#atoms, [name]);
    return (end.id ??= this.#add({ kind: "atom", name }));
  }

  #restrictedType(name: ValueKind, values: readonly ScalarValue[]): TypeId {
    const sorted = sortedValues(values);
    const end = branch(this.#restricted, [name, ...sorted]);
    return (end.id ??= this.#add({ kind: "restricted", name, values: Object.freeze(sorted) }));
  }

  #collection(kind: "list" | "set" | "dict", element: TypeId): TypeId {
    const end = branch(this.#collections, [kind, element]);
    return (end.id ??= this.#add({ kind, element }));
  }

  #object(properties: readonly { readonly name: string; readonly type: TypeId }[]): TypeId {
    const sorted = [...properties].sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
    const end = branch(
      this.#objects,
      sorted.flatMap((property) => [property.name, property.type]),
    );
    return (end.id ??= this.#add({
      kind: "object",
      properties: Object.freeze(sorted.map((property) => Object.freeze({ ...property }))),
    }));
  }

  /** The union of interned members: nested unions flattened, each id once, a single member standing alone. */
  #union(ids: readonly TypeId[]): TypeId {
    const flat = new Set<TypeId>();
    for (const id of ids) {
      const node = this.node(id);
      // A union node is flat already, so one level of flattening flattens every nesting.
      if (node.kind === "union") for (const member of node.members) flat.add(member);
      else flat.add(id);
    }
    const sorted = [...flat].sort((left, right) => left - right);
    if (sorted.length === 0) return this.#never;
    // EVIDENCE: invariant: the length is checked to be one.
    if (sorted.length === 1) return sorted[0]!;
    const end = branch(this.#unions, sorted);
    return (end.id ??= this.#add({ kind: "union", members: Object.freeze(sorted) }));
  }

  /** The `StaticType` of an id whose parts are built already. */
  #buildStatic(id: TypeId): StaticType {
    const node = this.node(id);
    switch (node.kind) {
      case "never":
        return NEVER_STATIC;
      case "null":
        return NULL_TYPE;
      case "unknown":
        return UNKNOWN_TYPE;
      case "atom":
        if (isScalarKind(node.name)) return Object.freeze({ kind: "scalar", name: node.name });
        if (isPlainKind(node.name)) return Object.freeze({ kind: node.name });
        throw new Error(`An atom holds a kind without parts, not '${node.name}'.`);
      case "restricted":
        if (!isScalarKind(node.name))
          throw new Error(`Only a scalar kind takes restricted values, not '${node.name}'.`);
        return Object.freeze({ kind: "scalar", name: node.name, values: node.values });
      case "list":
      case "set":
      case "dict":
        return Object.freeze({ kind: node.kind, element: this.#builtOf(node.element) });
      case "object":
        if (node.properties === null) return Object.freeze({ kind: "object", properties: null });
        return Object.freeze({
          kind: "object",
          properties: Object.freeze(
            new PropertyTable(
              node.properties.map((property) => [property.name, this.#builtOf(property.type)]),
            ),
          ),
        });
      case "union":
        return Object.freeze({
          kind: "union",
          members: Object.freeze(node.members.map((member) => this.#builtOf(member))),
        });
    }
  }

  #builtOf(id: TypeId): StaticType {
    const type = this.#statics[id];
    if (type === undefined) throw new Error("A part of the type was not built first.");
    return type;
  }
}
