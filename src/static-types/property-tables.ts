import { isCollection, resolved, UNKNOWN_TYPE, type StaticType } from "../static-types.js";

// The property tables of object types, and the lineage that tells which properties a read can find (#845).

/**
 * The properties of an object value with their types, each kept from its first value (ADR 0021 rule 1.4). `null`
 * stands for an object whose properties are unknown. A table belongs to one place, such as a variable or the elements
 * of a list, and grows when assignment adds a property.
 *
 * The script may run code in another order than the compiler checks it, so a table also records which objects may
 * reach its place when the script runs, for the end of the check to tell which properties a read can find (#845, see
 * {@link missingPropertyReads}).
 */
export class PropertyTable extends Map<string, StaticType> {
  /**
   * The tables of other places whose objects may reach this place, such as the original of a copy, which may still gain
   * a property later in checking order.
   */
  sources: Set<PropertyTable> | undefined = undefined;
  /** Whether an object whose properties the compiler cannot know may reach this place, such as a loaded value. */
  open = false;

  constructor(entries?: Iterable<readonly [string, StaticType]>) {
    super(entries);
    lineage?.tables.push(this);
  }
}

/**
 * What the current check recorded for {@link missingPropertyReads}: every table it built, and the stores that met a slot
 * still undecided, which are followed once the check knows what decided the slot. `null` outside a check.
 */
export let lineage: {
  readonly tables: PropertyTable[];
  readonly flows: (readonly [StaticType, StaticType])[];
} | null = null;

/** Starts recording the property lineage of a check (see {@link PropertyTable}). */
export function startPropertyLineage(): void {
  lineage = { tables: [], flows: [] };
}

/** Records that objects of the place of `source` may reach the place of `target` (see {@link PropertyTable.sources}). */
export function feed(target: PropertyTable, source: PropertyTable): void {
  if (target !== source) (target.sources ??= new Set()).add(source);
}

/**
 * Records what a value of `source`, stored in or passed to a place of `target`, may bring there (see
 * {@link PropertyTable}): the objects of its tables, or objects with any properties. Only the first tables on each side
 * are linked, through unions and collections; the end of the check derives what reaches the places of their
 * properties. A slot still undecided is followed once the check knows what decided it, and holds no object if nothing
 * did, unless a value the compiler cannot know reached it.
 */
export function flowInto(targetType: StaticType, sourceType: StaticType): void {
  const seen = new Map<StaticType, Set<StaticType>>();
  const pending: (readonly [StaticType, StaticType])[] = [[targetType, sourceType]];
  while (pending.length > 0) {
    const [targetPart, sourcePart] = pending.pop()!;
    const target = resolved(targetPart);
    const source = resolved(sourcePart);
    const reached = seen.get(target) ?? new Set<StaticType>();
    if (reached.has(source)) continue;
    reached.add(source);
    seen.set(target, reached);
    if (target.kind === "union")
      for (const member of target.members) pending.push([member, source]);
    else if (source.kind === "union")
      for (const member of source.members) pending.push([target, member]);
    // An undecided place takes a copy of the value that decides it, which keeps its sources.
    else if (target.kind === "open") continue;
    else if (source.kind === "open") {
      if (source.heldUnknown !== undefined) openTables(target);
      else lineage?.flows.push([target, source]);
    } else if (
      source.kind === "unknown" ||
      (source.kind === "object" && source.properties === null)
    )
      openTables(target);
    else if (
      target.kind === "object" &&
      target.properties !== null &&
      source.kind === "object" &&
      source.properties !== null
    )
      feed(target.properties, source.properties);
    else if (isCollection(target) && source.kind === target.kind)
      pending.push([target.element, source.element]);
  }
}

/**
 * Records that objects whose properties the compiler cannot know may reach the places of a type's first tables, such
 * as the value of a `load` (see {@link PropertyTable.open}). A slot still undecided is followed once the check knows
 * what decided it.
 */
export function openTables(type: StaticType): void {
  for (const part of firstParts(type))
    if (part.kind === "object" && part.properties !== null) part.properties.open = true;
    else if (part.kind === "open") lineage?.flows.push([part, UNKNOWN_TYPE]);
}

/** The parts of a type below its unions, lists, sets, and dicts, also through the types that decided slots. */
function firstParts(type: StaticType): StaticType[] {
  const found: StaticType[] = [];
  const seen = new Set<StaticType>();
  const pending = [type];
  while (pending.length > 0) {
    const part = resolved(pending.pop()!);
    if (seen.has(part)) continue;
    seen.add(part);
    if (part.kind === "union") for (const member of part.members) pending.push(member);
    else if (isCollection(part)) pending.push(part.element);
    else found.push(part);
  }
  return found;
}

/** A read of a property that the tables of its object lacked when the read was checked. */
export interface PropertyRead {
  readonly name: string;
  readonly tables: readonly PropertyTable[];
  /** Whether its error names the properties its objects can have, which takes a second walk of their places. */
  readonly named: boolean;
}

/** For each table, the tables that keep its objects in a property, with that property. */
type Holders = ReadonlyMap<PropertyTable, readonly (readonly [PropertyTable, string])[]>;

/**
 * The properties from the objects of a place down to the objects a read reads: `head` and then `tail`, or none, which
 * are `depth` properties. One object stands for each path, so a path is extended, shortened, and compared in constant
 * time.
 */
interface PropertyPath {
  readonly head: string | undefined;
  readonly tail: PropertyPath | undefined;
  readonly depth: number;
}

/**
 * Ends the recording of a check and tells for each read whether an object at its place can have its property when the
 * script runs (#845). It cannot when the property is in none of the tables whose objects may reach that place: the
 * place's own, their sources, and, for a place inside a property of another, that property of every table whose objects
 * may reach the other place. A read that no object can satisfy gives the properties its objects can have, in table
 * order, when its error names them, and none otherwise; any other gives `undefined`, also when objects whose properties
 * the compiler cannot know may reach the place.
 */
export function missingPropertyReads(
  reads: readonly PropertyRead[],
): (readonly string[] | undefined)[] {
  const recorded = lineage;
  lineage = null;
  if (recorded === null || reads.length === 0) return reads.map(() => undefined);
  // What reached a slot that was still undecided reaches what decided it; the recording has ended, so a slot that is
  // still undecided now is not followed again.
  for (const [target, source] of recorded.flows) flowInto(target, source);
  const holders = new Map<PropertyTable, (readonly [PropertyTable, string])[]>();
  for (const table of recorded.tables)
    for (const [name, type] of table)
      for (const part of firstParts(type))
        if (part.kind === "object" && part.properties !== null) {
          const held = holders.get(part.properties) ?? [];
          held.push([table, name]);
          holders.set(part.properties, held);
        }
  const root: PropertyPath = { head: undefined, tail: undefined, depth: 0 };
  const longer = new Map<PropertyPath, Map<string, PropertyPath>>();
  const extend = (head: string, tail: PropertyPath): PropertyPath => {
    const heads = longer.get(tail) ?? new Map<string, PropertyPath>();
    longer.set(tail, heads);
    const path = heads.get(head) ?? { head, tail, depth: tail.depth + 1 };
    heads.set(head, path);
    return path;
  };
  const byName = new Map<string, number[]>();
  for (const [index, read] of reads.entries()) {
    const indexes = byName.get(read.name) ?? [];
    indexes.push(index);
    byName.set(read.name, indexes);
  }
  const missing: (readonly string[] | undefined)[] = reads.map(() => undefined);
  for (const [name, indexes] of byName) {
    const places = new PropertyPlaces(name, holders, root, extend);
    for (const index of indexes) {
      const { tables, named } = reads[index]!;
      if (!places.read(tables)) missing[index] = named ? places.properties(tables) : [];
    }
  }
  return missing;
}

/**
 * The places whose objects may reach the places of the reads of one property, each a table and the path of properties
 * from its objects to the objects read: a source at the same path, the table that holds a table at a property, one
 * property up, and down a property again. A read visits the places that no earlier read of the property visited and
 * decides for each whether an object there may have the property, so every place is visited once for all reads.
 */
class PropertyPlaces {
  readonly #places: {
    readonly table: PropertyTable;
    readonly path: PropertyPath;
    readonly next: number[];
    may: boolean;
  }[] = [];
  readonly #ids = new Map<PropertyTable, Map<PropertyPath, number>>();

  constructor(
    readonly name: string,
    readonly holders: Holders,
    readonly root: PropertyPath,
    readonly extend: (head: string, tail: PropertyPath) => PropertyPath,
  ) {}

  /**
   * Whether an object read from one of `tables` may have the property: a place it reaches has it at the objects read,
   * or objects whose properties the compiler cannot know may reach one. A table that the read reaches again at a longer
   * path than one it reached it at holds objects at two depths of the objects read, as through `node = node.next`, so
   * the objects read may be any of its nested ones.
   */
  read(tables: readonly PropertyTable[]): boolean {
    const places = this.#places;
    // The places this read adds are numbered from `first` on.
    const first = places.length;
    // For each table, the paths this read reached it at, and the fewest properties of any of them.
    const reached = new Map<
      PropertyTable,
      { readonly paths: Set<PropertyPath>; shallowest: number }
    >();
    const place = (table: PropertyTable, path: PropertyPath): number | undefined => {
      const known = this.#ids.get(table)?.get(path);
      if (known !== undefined) return known;
      const earlier = reached.get(table);
      if (earlier === undefined)
        reached.set(table, { paths: new Set([path]), shallowest: path.depth });
      else {
        // Only a path with fewer properties can be one that `path` extends.
        for (
          let tail = path.tail;
          tail !== undefined && tail.depth >= earlier.shallowest;
          tail = tail.tail
        )
          if (earlier.paths.has(tail)) return undefined;
        earlier.paths.add(path);
        earlier.shallowest = Math.min(earlier.shallowest, path.depth);
      }
      const ids = this.#ids.get(table) ?? new Map<PropertyPath, number>();
      ids.set(path, places.length);
      this.#ids.set(table, ids);
      places.push({ table, path, next: [], may: false });
      return places.length - 1;
    };
    const starts = tables.map((table) => place(table, this.root)!);
    // The places this read added that may have the property by themselves.
    const found: number[] = [];
    for (let at = first; at < places.length; at += 1) {
      const { table, path, next } = places[at]!;
      let may = table.open || (path.head === undefined && table.has(this.name));
      const link = (other: number | undefined): void => {
        if (other === undefined) may = true;
        else next.push(other);
      };
      const value = path.head === undefined ? undefined : table.get(path.head);
      for (const part of value === undefined ? [] : firstParts(value))
        if (part.kind === "object" && part.properties !== null)
          link(place(part.properties, path.tail!));
        else if (
          part.kind === "unknown" ||
          part.kind === "object" ||
          (part.kind === "open" && part.heldUnknown !== undefined)
        )
          may = true;
      for (const source of table.sources ?? []) link(place(source, path));
      for (const [holder, property] of this.holders.get(table) ?? [])
        link(place(holder, this.extend(property, path)));
      if (may) found.push(at);
    }
    // A place that reaches one that may have the property may have it too; places of earlier reads are decided.
    const previous = new Map<number, number[]>();
    for (let at = first; at < places.length; at += 1)
      for (const other of places[at]!.next)
        if (other < first) {
          if (places[other]!.may) found.push(at);
        } else {
          const from = previous.get(other) ?? [];
          from.push(at);
          previous.set(other, from);
        }
    while (found.length > 0) {
      const at = found.pop()!;
      if (places[at]!.may) continue;
      places[at]!.may = true;
      for (const from of previous.get(at) ?? []) found.push(from);
    }
    return starts.some((at) => places[at]!.may);
  }

  /** The properties of the objects read from `tables`, which a read of them visited. */
  properties(tables: readonly PropertyTable[]): string[] {
    const names = new Set<string>();
    const pending = tables.map((table) => this.#ids.get(table)!.get(this.root)!);
    const reached = new Set(pending);
    for (let index = 0; index < pending.length; index += 1) {
      const { table, path, next } = this.#places[pending[index]!]!;
      if (path.head === undefined) for (const name of table.keys()) names.add(name);
      for (const other of next)
        if (!reached.has(other)) {
          reached.add(other);
          pending.push(other);
        }
    }
    return [...names];
  }
}
