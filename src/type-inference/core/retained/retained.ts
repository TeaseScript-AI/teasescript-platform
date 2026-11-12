/*
 * #1072 step 1b: the state the type core keeps between solver runs (a retained datum: anything a run computes that a
 * later run can observe without a solver read) is made and changed here. What may change in place is a closed list of
 * kinds, each made here at its creation site: a collection (`Retained.map`, `set`, `weakMap`, `weakSet`), a record
 * (`Retained.record`), an arena (`Retained.arena`: an array that only grows, each slot written once) and an array
 * (`Retained.array`); and an owner's own fields (`Retained.owner`), each change to one marked (`amend(owner)`,
 * `Retained.held`). Everything else kept is plain data, which no later run changes. With no instrument (production)
 * every kind is the native value it is given or makes, `owner` and `amend` return at once, and nothing is charged: what
 * runs and what it costs is unchanged. A test installs an instrument (`withRetainedRecorder`;
 * `tests/helpers/retained-instrument.ts`), which makes the kinds, refuses at its line any other write to retained
 * state, and hears the owners' marks and the solver's runs.
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
  /** A record made from `fields`, a fresh object literal (`Retained.record`). */
  record<T extends object>(name: string, fields: T): T;
  /** An arena made from `items`, a fresh array literal (`Retained.arena`). */
  arena<T>(name: string, items: T[]): T[];
  /** An array made from `items`, a fresh array literal (`Retained.array`). */
  array<T>(name: string, items: T[]): T[];
  /** `fn`, a function retained state may keep, registered where it is made (`Retained.closure`). */
  closure<T extends object>(name: string, fn: T): void;
  /** `program`, indexed: its graph is held as it is, never written after (`Retained.program`). */
  program<T extends object>(program: T): void;
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
/** The instrument installed for the whole process (`installRetainedRecorder`), which `withRetainedRecorder` stands over. */
let ambient: RetainedRecorder | null = null;

/** Test-only: installs `recorder` for the whole process (the frozen type-core suites' preload). */
export function installRetainedRecorder(recorder: RetainedRecorder): void {
  if (active !== null) throw new Error("A retained-state instrument is already installed.");
  ambient = active = recorder;
}

/** Test-only: runs `callback` with `recorder` making every retained kind and hearing every mark. */
export function withRetainedRecorder<T>(recorder: RetainedRecorder, callback: () => T): T {
  if (active !== ambient) throw new Error("A retained-state instrument is already installed.");
  const before = active;
  active = recorder;
  try {
    return callback();
  } finally {
    active = before;
  }
}

/** The installed recorder, `null` in production: the solver takes it once, when made. */
export function retainedRecorder(): RetainedRecorder | null {
  return active;
}

/** The one way a retained collection is made (`tools/oxlint/check-retained-state.mjs`). */
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
  /**
   * An object a later run may change in place, field by field. `fields` is a fresh object literal (the lint holds it):
   * production keeps it, and an instrument copies it, so no other reference may hold it.
   */
  record<T extends object>(name: string, fields: T): T {
    return active === null ? fields : active.record(name, fields);
  },
  /**
   * An array that only grows: a slot, once written, is never written again, and its length never falls. `items` is a
   * fresh array literal (the lint holds it), or none.
   */
  arena<T>(name: string, items: T[] = []): T[] {
    return active === null ? items : active.arena(name, items);
  },
  /** An array a later run may change in place anyhow (a work stack). `items` is a fresh array literal, or none. */
  array<T>(name: string, items: T[] = []): T[] {
    return active === null ? items : active.array(name, items);
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

/**
 * A module's retained collection (a capture): the native one made at its first use, or, while a recorder is
 * installed, the recorder's own for the module's name, made at its first use under that recorder.
 */
export function retainedModule<T>(name: string, make: (name: string) => T): () => T {
  let native: T | undefined;
  let recorded: { readonly by: RetainedRecorder; readonly value: T } | undefined;
  return () => {
    if (active === null) return (native ??= make(name));
    if (recorded?.by !== active) recorded = { by: active, value: make(name) };
    return recorded.value;
  };
}
