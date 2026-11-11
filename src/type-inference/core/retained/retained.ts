/*
 * #1072 step 1b: the state the type core keeps between solver runs (a retained datum: anything a run computes that a
 * later run can observe without a solver read) is made and changed here. An owner makes each collection it keeps
 * through `Retained`, registers itself (`Retained.owner`), and marks each change it makes in place to an object it
 * already keeps (`amend`); a write through a collection's own `set`, `add`, `delete` or `clear` is marked by the
 * collection. With no recorder (production, and the suites' default) every collection is the native one, `owner` and
 * `amend` return at once, and nothing is charged: what runs and what it costs is unchanged. A test installs a recorder
 * (`withRetainedRecorder`), which makes the collections and hears the marks, the owners and the solver's runs; it reads
 * and never writes retained state.
 */

/**
 * Test-only: what a recorder hears. Each collection made while it is installed is made by it; each name says the
 * owner and the field (`Contract.prefix`).
 */
export interface RetainedRecorder {
  map<K, V>(name: string, entries: Iterable<readonly [K, V]> | null): Map<K, V>;
  set<T>(name: string, values: Iterable<T> | null): Set<T>;
  weakMap<K extends object, V>(name: string): WeakMap<K, V>;
  weakSet<T extends object>(name: string): WeakSet<T>;
  /** An owner's own enumerable fields, each an entry; `hidden` gives its private ones that hold retained state. */
  owner<T extends object>(
    owner: T,
    name: string,
    hidden: ((owner: T) => Readonly<Record<string, unknown>>) | null,
  ): void;
  /** `target`, kept in retained state (or an owner), was changed in place by the current run. */
  amend<T extends object>(target: T): void;
  /** The solver's current run: a frame, a component being solved, a top-level computation; `null` outside one. */
  run<T extends object>(run: T | null): void;
}

let active: RetainedRecorder | null = null;

/** Test-only: runs `callback` with `recorder` making every retained collection and hearing every mark. */
export function withRetainedRecorder<T>(recorder: RetainedRecorder, callback: () => T): T {
  if (active !== null) throw new Error("A retained-state recorder is already installed.");
  active = recorder;
  try {
    return callback();
  } finally {
    active = null;
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

/** `target`, already kept in retained state, or an owner, was changed in place by the current run. */
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
