/*
 * #1072 step 1b: the state the type core keeps between solver runs (a retained datum: anything a run computes that a
 * later run can observe without a solver read) is made and changed here. What may change in place is a closed list of
 * kinds, each made here at its creation site: a collection (`Retained.map`, `set`, `weakMap`, `weakSet`), a record
 * (`Retained.record`), an arena (`Retained.arena`: an array that only grows, each slot written once) and an array
 * (`Retained.array`); and an owner's own fields (`Retained.owner`), each change to one marked (`amend(owner)`,
 * `Retained.held`). Everything else kept is plain data, which no later run changes. With no instrument (production)
 * a record, arena or array is a copy of what it is given (`retainedCopy`), a collection the native one it makes, `owner`
 * and `amend` return at once, and nothing is charged. A test installs an instrument (`withRetainedRecorder`;
 * `retained-instrument.ts`), which makes the kinds, refuses at its line any other write to retained
 * state, and hears the owners' marks and the solver's runs. A typed array, which no freeze holds, is the exception: a
 * write to its elements after its run is caught at the process's exit, which fails the file.
 */

/**
 * Test-only: what an instrument hears. Each kind made while it is installed is made by it; each name says the owner
 * and the field (`Contract.prefix`).
 */
export interface RetainedRecorder {
  map<K, V>(name: string, entries: Iterable<readonly [K, V]> | null): Map<K, V>;
  set<T>(name: string, values: Iterable<T> | null): Set<T>;
  weakMap<K extends object, V>(name: string): WeakMap<K, V>;
  weakSet<T extends object>(name: string): WeakSet<T>;
  /** A record made from `fields`, wrapping `retainedCopy`'s copy of them (`Retained.record`). */
  record<T extends object>(name: string, fields: T): T;
  /** An arena made from `items`, wrapping `retainedCopy`'s copy of them (`Retained.arena`). */
  arena<T>(name: string, items: T[]): T[];
  /** An array made from `items`, wrapping `retainedCopy`'s copy of them (`Retained.array`). */
  array<T>(name: string, items: T[]): T[];
  /** `fn`, a function retained state may keep, registered where it is made (`Retained.closure`). */
  closure<T extends object>(name: string, fn: T): void;
  /** `program`, indexed: its graph is held as it is, never written after (`Retained.program`). */
  program<T extends object>(program: T): void;
  /** `part`, an object of the indexed program, gives that program's walk its private fields (`Retained.programPart`). */
  programPart<T extends object>(
    part: T,
    hidden: (part: T) => Readonly<Record<string, unknown>>,
  ): void;
  /** An owner's own enumerable fields, each an entry; `hidden` gives its private ones that hold retained state. */
  owner<T extends object>(
    owner: T,
    name: string,
    hidden: ((owner: T) => Readonly<Record<string, unknown>>) | null,
  ): void;
  /** `target`, an owner, has a field changed in place by the current run. */
  amend<T extends object>(target: T): void;
  /** The solver's current run: a frame, a component being solved, a top-level computation; `null` outside one. */
  run<T extends object>(run: T | null): void;
}

let active: RetainedRecorder | null = null;
/**
 * The instrument installed for the whole process (`installRetainedRecorder`), which `withRetainedRecorder` stands
 * over.
 */
let ambient: RetainedRecorder | null = null;

/** Test-only: installs `instrument` for the whole process (the frozen type-core suites' preload). */
export function installRetainedRecorder(instrument: RetainedRecorder): void {
  if (active !== null) throw new Error("A retained-state instrument is already installed.");
  ambient = active = instrument;
}

/**
 * Test-only: runs `callback` with `instrument` in place of the process's own (`installRetainedRecorder`), if any,
 * making every retained kind and hearing every mark and run; refused while another stands over the process's own.
 */
export function withRetainedRecorder<T>(instrument: RetainedRecorder, callback: () => T): T {
  if (active !== ambient) throw new Error("A retained-state instrument is already installed.");
  const before = active;
  active = instrument;
  try {
    return callback();
  } finally {
    active = before;
  }
}

/** The installed instrument, `null` in production. */
export function retainedRecorder(): RetainedRecorder | null {
  return active;
}

/**
 * What a record, arena or array maker keeps (#1072 R46): a copy of `given`'s top level, an array's elements (`slice`,
 * holes kept) or an object's own enumerable fields on a new object of its prototype (`Object.assign`), so no reference a
 * caller holds reaches it. Production keeps the copy and an instrument wraps the same copy, so both read the same state
 * however the call is spelled. A value inside it stays itself in both, the plain data among them frozen by an
 * instrument at the run switch (#1072 R59).
 */
export function retainedCopy<T extends object>(given: T): T {
  // EVIDENCE: invariant: an array's copy is an array of its elements, an object's an object of its fields: `T`'s shape.
  return (
    Array.isArray(given)
      ? given.slice()
      : Object.assign(Object.create(Object.getPrototypeOf(given)) as object, given)
  ) as T;
}

/** The one way a retained collection is made (`check-retained-state`). */
export const Retained = {
  map<K, V>(name: string, entries: Iterable<readonly [K, V]> | null = null): Map<K, V> {
    if (active !== null) return active.map(name, entries);
    return entries === null ? new Map<K, V>() : new Map<K, V>(entries);
  },
  set<T>(name: string, values: Iterable<T> | null = null): Set<T> {
    if (active !== null) return active.set(name, values);
    return values === null ? new Set<T>() : new Set<T>(values);
  },
  weakMap<K extends object, V>(name: string): WeakMap<K, V> {
    return active === null ? new WeakMap<K, V>() : active.weakMap(name);
  },
  weakSet<T extends object>(name: string): WeakSet<T> {
    return active === null ? new WeakSet<T>() : active.weakSet(name);
  },
  /** An object a later run may change in place, field by field: a copy of `fields` (`retainedCopy`). */
  record<T extends object>(name: string, fields: T): T {
    return active === null ? retainedCopy(fields) : active.record(name, fields);
  },
  /**
   * An array that only grows: a slot, once written, is never written again, and its length never falls. A copy of
   * `items` (`retainedCopy`), or empty.
   */
  arena<T>(name: string, items: T[] = []): T[] {
    return active === null ? retainedCopy(items) : active.arena(name, items);
  },
  /** An array a later run may change in place anyhow (a work stack): a copy of `items` (`retainedCopy`), or empty. */
  array<T>(name: string, items: T[] = []): T[] {
    return active === null ? retainedCopy(items) : active.array(name, items);
  },
  /**
   * A function retained state may keep, registered where it is made (#1072 R26). The comment line before each call
   * names what the function captures and why that is covered: a closed-list kind or an owner, a value fixed when it is
   * made, or a module's own binding. The instrument does not see the captures; the comment is read at review.
   */
  closure<T extends (...args: never[]) => void>(name: string, fn: T): T {
    if (active !== null) active.closure(name, fn);
    return fn;
  },
  /**
   * The program, once indexed: every value its graph reaches is held as it is, as `CoreProgram` is (never written after
   * its indexing; a test's instrument freezes its plain data).
   */
  program<T extends object>(program: T): void {
    if (active !== null) active.program(program);
  },
  /**
   * `part`, an object of the indexed program, gives the instrument's walk of that program its private fields, which no
   * walk can see otherwise (one function per class, so production makes none per object; the lint holds each of the
   * class's private fields to it).
   */
  programPart<T extends object>(
    part: T,
    hidden: (part: T) => Readonly<Record<string, unknown>>,
  ): void {
    if (active !== null) active.programPart(part, hidden);
  },
  /** `made`, now held by `owner`, which this changes in place (`amend`): for a field filled on its first use. */
  held<O extends object, T>(owner: O, made: T): T {
    if (active !== null) active.amend(owner);
    return made;
  },
  /**
   * `owner` keeps retained state in its fields, and in the private ones `hidden` gives (one function per class, so
   * production makes none per owner).
   */
  owner<T extends object>(
    owner: T,
    name: string,
    hidden: ((owner: T) => Readonly<Record<string, unknown>>) | null = null,
  ): void {
    if (active !== null) active.owner(owner, name, hidden);
  },
};

/** `target`, an owner, has a field changed in place by the current run: marked before the write. */
export function amend<T extends object>(target: T): void {
  if (active !== null) active.amend(target);
}

/** The kinds a module's retained collection may be (`retainedModule`). */
type ModuleKind = "map" | "set" | "weakMap" | "weakSet";

/**
 * A module's retained collection (a capture) of `kind`, which this makes (#1072 R46): the native one made at its first
 * use, or, while an instrument is installed, the instrument's own for the module's name, made at its first use under
 * that instrument.
 */
export function retainedModule<K, V>(name: string, kind: "map"): () => Map<K, V>;
export function retainedModule<T>(name: string, kind: "set"): () => Set<T>;
export function retainedModule<K extends WeakKey, V>(
  name: string,
  kind: "weakMap",
): () => WeakMap<K, V>;
export function retainedModule<T extends WeakKey>(name: string, kind: "weakSet"): () => WeakSet<T>;
export function retainedModule(name: string, kind: ModuleKind): () => object {
  let native: object | undefined;
  let instrumented: { readonly by: RetainedRecorder; readonly value: object } | undefined;
  const make = (): object =>
    kind === "map"
      ? Retained.map(name)
      : kind === "set"
        ? Retained.set(name)
        : kind === "weakMap"
          ? Retained.weakMap(name)
          : Retained.weakSet(name);
  return () => {
    if (active === null) return (native ??= make());
    if (instrumented?.by !== active) instrumented = { by: active, value: make() };
    return instrumented.value;
  };
}
