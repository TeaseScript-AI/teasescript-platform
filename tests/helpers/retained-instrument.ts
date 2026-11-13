/*
 * #1072 step 1b: the test-mode instrument of the type core's retained state (`src/type-inference/core/retained/retained.ts`;
 * the plan `o4-lead/plans/1072-retained-head0.md`, Amendment 3, rulings R19 to R25).
 *
 * What it guarantees, and nothing stronger: a write to retained state is refused where it happens, or is made by a
 * closed-list kind's own writer (a `Retained` collection's `set`/`add`/`delete`/`clear`; a record's, an arena's or an
 * array's assignment, definition or deletion) or is a marked write to an owner's own field. A typed array
 * (`TYPED_ENTRIES`), which no freeze holds, is the exception: a write to its elements after its run ended is caught at
 * the process's exit (`changedTyped`), which fails the file, not at its line. Every refusal it throws is counted, so
 * one a `catch` swallows fails the file at its exit too; V8's own error at a write to frozen data is kept from any
 * handler in `src/type-inference/` by the lint's `catch` rule (R60). A write made through an
 * intrinsic taken from a prototype (`Map.prototype.set` and its kind, called, bound or aliased) is outside what the
 * instrument sees, and is held out of the code by the lint (`tools/oxlint/check-retained-state.mjs`). The instrument does
 * not see what a registered function (`Retained.closure`) captures; that rests on the comment at each registration,
 * read at review; the function's own properties are frozen at its registration. It changes no answer and no charge.
 *
 * How:
 * - What may be stored is a closed set of shapes, checked where it is stored (a collection's `set`/`add`, a map's object
 *   key too; a record's, an arena's or an array's write) and again at the next run switch: a primitive; plain data (an
 *   object of prototype `Object.prototype` or `null`, or an array of `Array.prototype`, data properties only); a kind
 *   made by `Retained`; a registered owner; a registered function; a value the indexed program reaches
 *   (`Retained.program` and its parts, `Retained.programPart`: its plain data frozen there, its native collections given
 *   writers that refuse); an instance of a class of `IDENTITY_CLASSES`; a typed array under
 *   an entry of `TYPED_ENTRIES`. Anything else is refused: a native collection as a payload, any other function, an
 *   accessor, any other class instance. The walk reads descriptors only; it calls no getter and no iterator of an instance.
 * - At each run switch the solver reports, what the run that ended stored is checked again, and its plain data frozen in
 *   place: a later write to it throws at its line (strict modules).
 * - Each kind is made here: a collection is the native one of production's prototype, given its own writers, then made
 *   non-extensible, so a new own property on it throws; a record, an arena or an array is a proxy over the copy of the
 *   given top level that production keeps too (`retainedCopy`), which refuses a write outside its kind. What that top
 *   level reaches stays shared with the caller, and is frozen at the switch.
 * - An owner is locked at the switch after it is made: its own fields read-only and none added, so a write to one throws
 *   at its line unless its run marked the owner first (`amend(owner)`, `Retained.held`), which opens its fields until the
 *   switch and in the run's later intervals. Its values are checked and sealed at each lock. The private fields its
 *   `hidden` shows are read once, at the first lock (the lint holds them `readonly`; what an owner fills later is a record).
 */
import { Closure } from "../../src/type-inference/core/admission/closure.js";
import { WorkLedger } from "../../src/type-inference/core/budget.js";
import { ReceivingDomain } from "../../src/type-inference/core/inherited/receiving-domain.js";
import { PathSteps } from "../../src/type-inference/core/contract/key-ids.js";
import { ContractCounters, SupportIds } from "../../src/type-inference/core/contract/model.js";
import { IngressGraph } from "../../src/type-inference/core/items.js";
import { CoreProgram } from "../../src/type-inference/core/program.js";
import {
  retainedCopy,
  type RetainedRecorder,
} from "../../src/type-inference/core/retained/retained.js";
import { Solver } from "../../src/type-inference/core/solver.js";

/** The prefix of every refusal's message, so a refusal is told from a domain error. */
export const REFUSED = "retained state: refused";

/** A negative control's marker (`tests/type-core/retained-instrument.test.ts`): a listed class of no other use. */
export class InstrumentProbe {}

/**
 * The classes whose instances retained state holds as they are, by the class itself (never by its name), each with its
 * reason: why a later run cannot observe a change in one through retained state. An instance of any other class is
 * refused, a subclass of a listed one included.
 */
const IDENTITY_CLASSES: ReadonlyMap<unknown, string> = new Map<unknown, string>([
  [
    Solver,
    "the solver's own records: a run reads them through solver reads, never as retained data",
  ],
  [
    WorkLedger,
    "the work ledger: every charge changes it, and a stop reads it under the resource rule",
  ],
  [
    IngressGraph,
    "the item scope's intern tables: what they hand out is plain data or a recorded cell (`IngressGraph.cell`)",
  ],
  [
    CoreProgram,
    "the program, indexed before the first pass and read by every pass, never written after",
  ],
  [
    ContractCounters,
    "the run facts' counters: every run adds to them, and they are only copied into the answers' facts after the analysis",
  ],
  [
    SupportIds,
    "the support nodes' ids, a pass-wide allocator never reused nor rolled back (the lifecycle's rule for ids)",
  ],
  [
    PathSteps,
    "steps: fixed when made, and what they find later (their path's id and text, their views) is in a record of theirs",
  ],
  [
    ReceivingDomain,
    "A4's receiving domain, which admission makes and writes: its retained state is #1072 step 1b part ii's to record",
  ],
  [
    Closure,
    "admission's receiving closure: its retained state is #1072 step 1b part ii's to record",
  ],
  [InstrumentProbe, "a negative control's own marker, never changed"],
]);

/** The entries whose typed arrays are held as they are, each with its reason. */
const TYPED_ENTRIES: ReadonlyMap<string, string> = new Map([
  [
    "DefinitionLists.#sorted",
    "built locally and published whole (`definitions.ts`, `DefinitionLists`), never written after",
  ],
  ["DefinitionLists.#below", "as `#sorted`"],
]);

const PLAIN = new Set<unknown>([Object.prototype, null]);
const NATIVE_COLLECTIONS = new Set<unknown>([
  Map.prototype,
  Set.prototype,
  WeakMap.prototype,
  WeakSet.prototype,
]);
/** The writers of a native collection the program's walk reaches, by its prototype: each refuses (R61). */
const PROGRAM_WRITERS = new Map<unknown, readonly string[]>([
  [Map.prototype, ["set", "delete", "clear"]],
  [Set.prototype, ["add", "delete", "clear"]],
  [WeakMap.prototype, ["set", "delete"]],
  [WeakSet.prototype, ["add", "delete"]],
]);
const INDEX = /^(?:0|[1-9]\d*)$/;
// (taken before any test runs: the program's walk reads native collections by these alone)
const MAP_FOR_EACH = Map.prototype.forEach;
const SET_FOR_EACH = Set.prototype.forEach;

type Method = (this: WeakKey, ...args: unknown[]) => WeakKey;
type KindName = "map" | "set" | "weakMap" | "weakSet" | "record" | "arena" | "array";

/** A kind made here: its instrument, its name and kind, and what holds its contents (a collection itself, a proxy's private target). */
interface Made {
  readonly instrument: RetainedInstrument;
  readonly name: string;
  readonly kind: KindName;
  readonly holder: object;
}

const MADE = new WeakMap<WeakKey, Made>();
/** A run token for an interval outside any solver run. */
function outsideRun(): WeakKey {
  return { outside: true };
}
/** Each maker's proxy's own traps (`watchRecord`). */
const HANDLERS = new WeakMap<WeakKey, ProxyHandler<object>>();

/**
 * A test's observer of one field of a record (`tests/helpers/type-core-held-host.ts`), through the record's own proxy:
 * `read` is told each value read there, `written` each value written there once the record's own trap took it; a
 * write still passes the record's checks. `false` where `record` is no maker's proxy (no instrument installed).
 */
export function watchRecord(
  record: WeakKey,
  field: string,
  read: (value: unknown) => void,
  written: (value: unknown) => void,
): boolean {
  const handler = HANDLERS.get(record);
  if (handler === undefined) return false;
  const { get, set } = handler;
  handler.get = (target, key, receiver) => {
    const value =
      get === undefined
        ? // oxlint-disable-next-line anti-slop/no-reflect-get -- EVIDENCE: fixture: a test's observer forwards the proxy's read unchanged.
          Reflect.get(target, key, receiver)
        : get(target, key, receiver);
    if (key === field) read(value);
    return value;
  };
  handler.set = (target, key, value, receiver): boolean => {
    const done =
      set === undefined
        ? Reflect.set(target, key, value, receiver)
        : set(target, key, value, receiver);
    if (key === field && done) written(value);
    return done;
  };
  return true;
}

/** An object's class: its prototype's own `constructor` where that is a data field, read through its descriptor. */
function constructorOf<T extends object>(value: T): WeakKey | undefined {
  const prototype: unknown = Object.getPrototypeOf(value);
  if (typeof prototype !== "object" || prototype === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "constructor");
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

function className<T extends object>(value: T): string {
  const made = constructorOf(value);
  return typeof made === "function" ? made.name || "anonymous" : "anonymous";
}

/** The first stack frame outside the instrument and the retained module: where a write was made. */
function siteOf(stack: string | undefined): string {
  for (const line of (stack ?? "").split("\n").slice(1)) {
    if (line.includes("retained-instrument") || line.includes("retained/retained")) continue;
    const at = /\(?([^()\s]+):(\d+):\d+\)?$/.exec(line.trim());
    if (at !== null) return `${at[1]!.replace(/^.*\/(src|dist|tests)\//, "$1/")}:${at[2]}`;
  }
  return "unknown";
}

/** A test helper's observer of a made map's writes (`watchWrites`), called after each, by the map. */
const WATCHERS = new WeakMap<WeakKey, (key: unknown, value: unknown) => void>();

/**
 * Has `written` called after each write to `map`, a map `Retained` made, through the instrument's own writer, which
 * stays in place: a test helper observes the map so (`type-core-held-host.ts`). `false`, and nothing done, for a map
 * the instrument did not make.
 */
export function watchWrites<K, V>(map: Map<K, V>, written: (key: K, value: V) => void): boolean {
  if (MADE.get(map)?.kind !== "map") return false;
  const before = WATCHERS.get(map);
  WATCHERS.set(map, (key, value) => {
    before?.(key, value);
    // EVIDENCE: invariant: the map's own writer passes the key and value it was given, of the map's types.
    written(key as K, value as V);
  });
  return true;
}

/** The writers a collection is given (one function each for all collections, so its call sites stay production's). */
const COLLECTION_WRITERS: Readonly<
  Record<"map" | "set" | "weakMap" | "weakSet", Readonly<Record<string, Method>>>
> = {
  map: {
    set(this: WeakKey, key: unknown, value: unknown): WeakKey {
      const made = MADE.get(this)!;
      made.instrument.stored(made, key, value, true);
      const done = Map.prototype.set.call(this, key, value);
      WATCHERS.get(this)?.(key, value);
      return done;
    },
  },
  weakMap: {
    set(this: WeakKey, key: unknown, value: unknown): WeakKey {
      const made = MADE.get(this)!;
      made.instrument.stored(made, key, value, true);
      // EVIDENCE: invariant: a weak map's key is an object; the native writer refuses one that is not.
      return WeakMap.prototype.set.call(this, key as object, value);
    },
  },
  set: {
    add(this: WeakKey, value: unknown): WeakKey {
      const made = MADE.get(this)!;
      made.instrument.stored(made, value, value, false);
      return Set.prototype.add.call(this, value);
    },
  },
  weakSet: {
    add(this: WeakKey, value: unknown): WeakKey {
      const made = MADE.get(this)!;
      made.instrument.stored(made, value, value, false);
      // EVIDENCE: invariant: a weak set's member is an object; the native writer refuses one that is not.
      return WeakSet.prototype.add.call(this, value as object);
    },
  },
};

/** What the instrument reports. */
export interface InstrumentReport {
  readonly switches: number;
  /** The plain objects frozen. */
  readonly sealed: number;
  /** The kinds made, by kind. */
  readonly made: ReadonlyMap<KindName, number>;
  /** Writes outside any solver run (R3), by owner or kind name and site, with their counts. */
  readonly outside: ReadonlyMap<string, number>;
  /** `amend` of an object that is no owner, by site: a mark this construction no longer reads. */
  readonly valueMarks: ReadonlyMap<string, number>;
  /** The refusals noted in a survey (`note`), with their counts. */
  readonly noted: ReadonlyMap<string, number>;
  /** The owners made, by name. */
  readonly owners: ReadonlyMap<string, number>;
  /** Owners opened by a mark after their lock, by name. */
  readonly opened: ReadonlyMap<string, number>;
  /** What a measurement saw made (`measure`), each by its name and site. */
  readonly exercised: ReadonlySet<string>;
  /** The refusals this instrument threw, wherever they were caught: the preload fails the file when any was. */
  readonly raised: number;
}

/**
 * An owner: its name, how to read the private fields it shows (`hidden`, read once), its own keys once locked (`null`
 * before), and whether they are open for writes now.
 */
interface OwnerRecord {
  readonly owner: object;
  readonly name: string;
  readonly hidden: ((owner: never) => Readonly<Record<string, unknown>>) | null;
  /** Its own data fields, once settled (`null` before): those a lock makes read-only and a mark writable. */
  keys: readonly PropertyKey[] | null;
  open: boolean;
}

/** An instrument's options: `note` notes each refusal of a shape or an owner's field and goes on (a survey's mode). */
export interface InstrumentOptions {
  readonly note?: boolean;
  /**
   * A measurement's mode (`measure`): each kind made, owner made and function registered is named with the site that made
   * it, for the frozen subset's cover (`tests/helpers/retained-subset.ts`).
   */
  readonly measure?: boolean;
  /** A survey's trace: called every 2,000th switch with the report so far. */
  readonly trace?: ((report: InstrumentReport) => void) | undefined;
}

export class RetainedInstrument implements RetainedRecorder {
  readonly #note: boolean;
  readonly #measure: boolean;
  /** What a measurement saw made (`measure`): a kind, an owner or a function, by its name and the site that made it. */
  readonly #exercised = new Set<string>();
  readonly #trace: ((report: InstrumentReport) => void) | null;
  /** The refusals noted (`note`), by their text with numbers made `N`, with their counts. */
  readonly #noted = new Map<string, number>();

  public constructor(options: InstrumentOptions = {}) {
    this.#note = options.note === true;
    this.#measure = options.measure === true;
    this.#trace = options.trace ?? null;
  }

  /** The refusals thrown, counted where they are raised, so one a `catch` swallows still fails the file. */
  #raised = 0;

  #raise(what: string): never {
    this.#raised += 1;
    throw new TypeError(`${REFUSED}: ${what}`);
  }

  #refuse(what: string): void {
    if (!this.#note) this.#raise(what);
    const key = what.replace(/\d+/g, "N");
    this.#noted.set(key, (this.#noted.get(key) ?? 0) + 1);
  }

  readonly #registered = new WeakSet<object>();
  readonly #ownerOf = new WeakMap<object, OwnerRecord>();
  /** The functions registered since the last switch, whose own properties' values are sealed there. */
  #functions: (readonly [string, object])[] = [];

  /** `fn`'s own data properties' values (a frozen function's, fixed from its registration). */
  #ownValues<T extends object>(fn: T): unknown[] {
    return Reflect.ownKeys(fn).flatMap((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(fn, key)!;
      return "value" in descriptor ? [descriptor.value] : [];
    });
  }

  /** What was stored since the last switch: a kind and the key or slot it was stored at. */
  #pending: (readonly [Made, unknown])[] = [];
  /** The owners made since the last switch, to lock there; and those open for writes in this interval, to lock again. */
  #newOwners: OwnerRecord[] = [];
  #open: OwnerRecord[] = [];
  /** Owners made, by name. */
  readonly #ownerCounts = new Map<string, number>();
  /** Owners opened by a mark after their lock, by name. */
  readonly #openCounts = new Map<string, number>();
  readonly #sealed = new WeakSet<object>();
  #sealedCount = 0;
  /**
   * Each typed array sealed (`TYPED_ENTRIES`), which no freeze holds: a copy of its bytes when its run ended, and where
   * it was met; `changedTyped` compares them. Held strongly to the process's exit, so a write is not lost with it.
   */
  readonly #typed: {
    readonly view: ArrayBufferView;
    readonly bytes: Uint8Array;
    readonly path: string;
  }[] = [];
  readonly #typedSeen = new WeakSet<ArrayBufferView>();
  /** The current run; an interval outside any solver run is a run of its own. */
  #run: WeakKey = outsideRun();
  #outside = true;
  /** The owners each run marked, in any of its intervals (a mark stands before the write it covers, R14). */
  readonly #marks = new WeakMap<WeakKey, Set<OwnerRecord>>();
  #switches = 0;
  readonly #made = new Map<KindName, number>();
  readonly #outsideWrites = new Map<string, number>();
  readonly #valueMarks = new Map<string, number>();

  /**
   * Where a typed array sealed at a run's end (`TYPED_ENTRIES`) holds other bytes now: a write no freeze could refuse at
   * its line, caught here instead. The preload asks at the process's exit and fails the file, or a survey counts it.
   */
  public changedTyped(): string[] {
    const changed: string[] = [];
    for (const { view, bytes, path } of this.#typed) {
      const current = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
      if (current.length !== bytes.length || current.some((byte, at) => byte !== bytes[at]))
        changed.push(path);
    }
    return changed;
  }

  public report(): InstrumentReport {
    return {
      switches: this.#switches,
      sealed: this.#sealedCount,
      made: this.#made,
      outside: this.#outsideWrites,
      valueMarks: this.#valueMarks,
      noted: this.#noted,
      owners: this.#ownerCounts,
      opened: this.#openCounts,
      exercised: this.#exercised,
      raised: this.#raised,
    };
  }

  /**
   * A function retained state may keep (`Retained.closure`): admitted, and its own properties frozen (R61); their values
   * are checked now and sealed at the switch, as a store's are.
   */
  public closure<T extends object>(name: string, fn: T): void {
    this.#registered.add(fn);
    Object.freeze(fn);
    for (const value of this.#ownValues(fn)) this.#admit(value, `function ${name}`, false);
    this.#functions.push([name, fn]);
    this.#exercise(`function ${name}`);
  }

  /**
   * The indexed program (`Retained.program`): every object its graph reaches, through data fields and native
   * collections' entries (read by the intrinsics), is admitted as it is, its plain data frozen and its native
   * collections given writers that refuse, as the program is never written after its indexing. The walk stops at a
   * listed class's instance.
   */
  public program<T extends object>(program: T): void {
    this.#programGraph(program, [program]);
  }

  /** A part of the program (`Retained.programPart`), whole when given: walked as the program is, its private fields with it. */
  public programPart<T extends object>(
    part: T,
    hidden: (part: T) => Readonly<Record<string, unknown>>,
  ): void {
    this.#programGraph(part, [part, ...Object.values(hidden(part))]);
  }

  #programGraph<T extends object>(root: T, stack: unknown[]): void {
    while (stack.length > 0) {
      const value = stack.pop();
      if ((typeof value !== "object" || value === null) && typeof value !== "function") continue;
      if (this.#registered.has(value)) continue;
      // (a listed class's instance stays its own: the work ledger and the item scope change after the indexing)
      if (value !== root && IDENTITY_CLASSES.has(constructorOf(value))) continue;
      this.#registered.add(value);
      if (typeof value === "function") continue;
      const prototype: unknown = Object.getPrototypeOf(value);
      if (prototype === Map.prototype)
        MAP_FOR_EACH.call(value, (item: unknown, key: unknown) => stack.push(key, item));
      else if (prototype === Set.prototype)
        SET_FOR_EACH.call(value, (item: unknown) => stack.push(item));
      const writers = PROGRAM_WRITERS.get(prototype);
      if (writers !== undefined) {
        // (non-configurable and read-only, as a made collection's: none falls back to the native writer)
        for (const writer of writers)
          Object.defineProperty(value, writer, {
            value: (): never =>
              this.#raise(
                `a write to the indexed program's collection (\`${writer}\`) at ${siteOf(new Error().stack)}`,
              ),
            writable: false,
            configurable: false,
          });
        Object.preventExtensions(value);
      }
      if (ArrayBuffer.isView(value)) continue;
      for (const key of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
        if ("value" in descriptor) stack.push(descriptor.value);
      }
      if (prototype === Array.prototype || PLAIN.has(prototype)) Object.freeze(value);
    }
  }

  #count(kind: KindName, name: string): void {
    this.#made.set(kind, (this.#made.get(kind) ?? 0) + 1);
    this.#exercise(`${kind} ${name}`);
  }

  #exercise(what: string): void {
    if (this.#measure) this.#exercised.add(`${what} @ ${siteOf(new Error().stack)}`);
  }

  #outsideWrite(name: string): void {
    if (!this.#outside) return;
    const key = `${name} at ${siteOf(new Error().stack)}`;
    this.#outsideWrites.set(key, (this.#outsideWrites.get(key) ?? 0) + 1);
  }

  /** A collection's or a maker's store of `value` (and, for a map, of its object `key`): checked now, sealed at the switch. */
  public stored(made: Made, key: unknown, value: unknown, keyed: boolean): void {
    if (keyed && typeof key === "object" && key !== null)
      this.#admit(key, `${made.name}'s key`, false);
    this.#admit(value, made.name, false);
    // (a primitive stored under a primitive key has nothing to check again or seal at the switch; one written over it
    // later is a store of its own)
    if (
      (typeof value === "object" && value !== null) ||
      typeof value === "function" ||
      (keyed && typeof key === "object" && key !== null)
    )
      this.#pending.push([made, key]);
    this.#outsideWrite(made.name);
  }

  #collection<T extends object>(
    made: T,
    kind: "map" | "set" | "weakMap" | "weakSet",
    name: string,
  ): T {
    MADE.set(made, { instrument: this, name, kind, holder: made });
    // (non-configurable and read-only: nothing removes or replaces a writer, so none falls back to the native one)
    for (const [writer, method] of Object.entries(COLLECTION_WRITERS[kind]))
      Object.defineProperty(made, writer, { value: method, writable: false, configurable: false });
    // (R24 a: a new own property on a collection throws at its line)
    Object.preventExtensions(made);
    this.#registered.add(made);
    this.#count(kind, name);
    return made;
  }

  public map<K, V>(name: string, entries: Iterable<readonly [K, V]> | null): Map<K, V> {
    const made = this.#collection(new Map<K, V>(), "map", name);
    for (const [key, value] of entries ?? []) made.set(key, value);
    return made;
  }

  public set<T>(name: string, values: Iterable<T> | null): Set<T> {
    const made = this.#collection(new Set<T>(), "set", name);
    for (const value of values ?? []) made.add(value);
    return made;
  }

  public weakMap<K extends object, V>(name: string): WeakMap<K, V> {
    return this.#collection(new WeakMap<K, V>(), "weakMap", name);
  }

  public weakSet<T extends object>(name: string): WeakSet<T> {
    return this.#collection(new WeakSet<T>(), "weakSet", name);
  }

  /**
   * A maker's copy of what it is given, the one production keeps (`retainedCopy`, R59), after refusing what that copy
   * would not keep: a prototype other than a plain object's or an array's, an accessor, a field that is not plain data,
   * an array's field that is not an element. Its descriptors are read, none of them run.
   */
  #copy<T extends object>(given: T, kind: "record" | "arena" | "array", name: string): object {
    const prototype: unknown = Object.getPrototypeOf(given);
    if (kind === "record" ? !PLAIN.has(prototype) : prototype !== Array.prototype)
      this.#raise(
        `${name}: a ${kind} is made from ${kind === "record" ? "an object" : "an array"} of another prototype`,
      );
    for (const key of Reflect.ownKeys(given)) {
      if (kind !== "record" && key === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(given, key)!;
      if (!("value" in descriptor))
        this.#raise(`${name}: an accessor \`${String(key)}\` in what a ${kind} is made from`);
      if (kind !== "record" && (typeof key !== "string" || !INDEX.test(key)))
        this.#raise(`${name}: a field \`${String(key)}\` of what an ${kind} is made from`);
      if (!descriptor.writable || !descriptor.enumerable || !descriptor.configurable)
        this.#raise(
          `${name}: a field \`${String(key)}\` of what a ${kind} is made from is not plain data`,
        );
    }
    return retainedCopy(given);
  }

  #maker<T extends object>(given: T, kind: "record" | "arena" | "array", name: string): T {
    const target = this.#copy(given, kind, name);
    const handler = this.#traps(kind, name);
    const proxy = new Proxy(target, handler);
    const made: Made = { instrument: this, name, kind, holder: target };
    MADE.set(proxy, made);
    HANDLERS.set(proxy, handler);
    this.#byTarget.set(target, made);
    this.#registered.add(proxy);
    for (const key of Reflect.ownKeys(target)) {
      // (an array's or an arena's length is no element; a record's `length` is a field like any other)
      if (kind !== "record" && key === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(target, key)!;
      this.#admit(descriptor.value, name, false);
      if (typeof descriptor.value === "object" || typeof descriptor.value === "function")
        this.#pending.push([made, key]);
    }
    this.#count(kind, name);
    // EVIDENCE: invariant: the proxy stands for its target, a copy of `given` of the same shape.
    return proxy as T;
  }

  /** A maker's traps: each write checked and queued; a write outside its kind refused. */
  #traps(kind: "record" | "arena" | "array", name: string): ProxyHandler<object> {
    const write = <T extends object>(target: T, key: string | symbol, value: unknown): void => {
      if (kind === "record") {
        if (typeof key === "symbol") this.#raise(`${name}: a symbol field of a record`);
      } else if (key === "length") {
        // EVIDENCE: invariant: an array's length is a number, which the native write checks.
        const length = value as number;
        if (kind === "arena" && Array.isArray(target) && length < target.length)
          this.#raise(`${name}: an arena's length falls`);
        return;
      } else if (typeof key !== "string" || !INDEX.test(key))
        this.#raise(`${name}: a field \`${String(key)}\` of an ${kind}`);
      else if (kind === "arena" && Object.hasOwn(target, key))
        this.#raise(`${name}: slot ${key} of an arena, written already`);
      this.#admit(value, name, false);
      const made = this.#byTarget.get(target);
      if (made !== undefined) this.#pending.push([made, key]);
      this.#outsideWrite(name);
    };
    return {
      set: (target, key, value): boolean => {
        write(target, key, value);
        return Reflect.set(target, key, value);
      },
      defineProperty: (target, key, descriptor): boolean => {
        if (
          !("value" in descriptor) &&
          (descriptor.get !== undefined || descriptor.set !== undefined)
        )
          this.#raise(`${name}: an accessor \`${String(key)}\` defined on a ${kind}`);
        write(target, key, descriptor.value);
        return Reflect.defineProperty(target, key, descriptor);
      },
      deleteProperty: (target, key): boolean => {
        if (kind === "arena") this.#raise(`${name}: a delete in an arena`);
        this.#outsideWrite(name);
        return Reflect.deleteProperty(target, key);
      },
      setPrototypeOf: (): boolean => this.#raise(`${name}: a ${kind}'s prototype changed`),
      preventExtensions: (): boolean => this.#raise(`${name}: a ${kind} made non-extensible`),
    };
  }

  /** Each maker's private target, so a definition through its trap finds its kind. */
  readonly #byTarget = new WeakMap<object, Made>();

  public record<T extends object>(name: string, fields: T): T {
    return this.#maker(fields, "record", name);
  }

  public arena<T>(name: string, items: T[]): T[] {
    return this.#maker(items, "arena", name);
  }

  public array<T>(name: string, items: T[]): T[] {
    return this.#maker(items, "array", name);
  }

  public owner<T extends object>(
    owner: T,
    name: string,
    hidden: ((owner: T) => Readonly<Record<string, unknown>>) | null,
  ): void {
    const record: OwnerRecord = { owner, name, hidden, keys: null, open: true };
    this.#ownerOf.set(owner, record);
    this.#registered.add(owner);
    this.#newOwners.push(record);
    this.#ownerCounts.set(name, (this.#ownerCounts.get(name) ?? 0) + 1);
    this.#exercise(`owner ${name}`);
  }

  public amend<T extends object>(target: T): void {
    const owner = this.#ownerOf.get(target);
    if (owner === undefined) {
      // (a survey names each one's site; a frozen run only counts them, a stack each being dear)
      const site = this.#note ? siteOf(new Error().stack) : "any";
      this.#valueMarks.set(site, (this.#valueMarks.get(site) ?? 0) + 1);
      return;
    }
    let marked = this.#marks.get(this.#run);
    if (marked === undefined) this.#marks.set(this.#run, (marked = new Set()));
    marked.add(owner);
    this.#unlock(owner);
    this.#outsideWrite(owner.name);
  }

  public run<T extends object>(run: T | null): void {
    if (run === this.#run || (run === null && this.#outside)) return;
    this.#switches += 1;
    if (this.#trace !== null && this.#switches % 2000 === 0) this.#trace(this.report());
    this.checkpoint();
    this.#run = run ?? { outside: true };
    this.#outside = run === null;
    // (a run's marks stand in each of its intervals)
    for (const owner of this.#marks.get(this.#run) ?? []) this.#unlock(owner);
  }

  /**
   * The switch: what the ended run stored is checked again and its plain data frozen; each owner made in it, or opened by
   * its marks, has its fields checked and sealed, then is locked: its own fields read-only, no field added. A later
   * write to a locked owner's field throws at its line unless its run marks the owner first.
   */
  public checkpoint(): void {
    const functions = this.#functions;
    this.#functions = [];
    for (const [name, fn] of functions)
      for (const value of this.#ownValues(fn)) this.#admit(value, `function ${name}`, true);
    const pending = this.#pending;
    this.#pending = [];
    for (const entry of pending) {
      const [made, key] = entry;
      // (an object key is sealed while its entry stands, whatever its value, `undefined` included)
      if (
        typeof key === "object" &&
        key !== null &&
        (made.kind === "map"
          ? Map.prototype.has.call(made.holder, key)
          : made.kind === "weakMap" && WeakMap.prototype.has.call(made.holder, key))
      )
        this.#admit(key, `${made.name}'s key`, true);
      const value = this.#current(made, key);
      if (value !== undefined) this.#admit(value, made.name, true);
    }
    const made = this.#newOwners;
    this.#newOwners = [];
    for (const owner of made) this.#settle(owner);
    const open = this.#open;
    this.#open = [];
    for (const owner of open) if (owner.keys !== null && owner.open) this.#lock(owner);
  }

  /**
   * An owner's first switch: its own fields, read by their descriptors, each a data field (an accessor is refused, but
   * for a getter without a setter that `hidden` shows), and the private ones its `hidden` shows, read this once (the
   * lint holds those `readonly`), admitted and sealed; then it is made non-extensible and locked.
   */
  #settle(record: OwnerRecord): void {
    const { owner } = record;
    // EVIDENCE: invariant: `hidden` was given for this owner's class, so it takes this owner.
    const hidden = record.hidden as ((owner: WeakKey) => Readonly<Record<string, unknown>>) | null;
    const shown = hidden === null ? {} : hidden(owner);
    for (const key in shown) this.#admit(shown[key], `${record.name}.#${key}`, true);
    const data: PropertyKey[] = [];
    for (const key of Reflect.ownKeys(owner)) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, key)!;
      if ("value" in descriptor) {
        this.#admit(descriptor.value, `${record.name}.${String(key)}`, true);
        data.push(key);
      }
      // (an own getter without a setter that `hidden` shows, read there: a value fixed once its owner is made, as
      // `CorePass`'s; made non-configurable, so nothing replaces it later)
      else if (typeof key === "string" && Object.hasOwn(shown, key) && descriptor.set === undefined)
        Object.defineProperty(owner, key, { configurable: false });
      else this.#refuse(`an accessor \`${String(key)}\` of the owner ${record.name}`);
    }
    record.keys = data;
    Object.preventExtensions(owner);
    this.#lock(record);
  }

  /** Each of a settled owner's own data fields made read-only, its values admitted and sealed first. */
  #lock(record: OwnerRecord): void {
    const { owner } = record;
    for (const key of record.keys!) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, key)!;
      this.#admit(descriptor.value, `${record.name}.${String(key)}`, true);
      if (descriptor.writable === true) Object.defineProperty(owner, key, { writable: false });
    }
    record.open = false;
  }

  /** A marked owner's own fields made writable again for the rest of this interval (it is locked at the switch). */
  #unlock(record: OwnerRecord): void {
    if (record.open) {
      if (record.keys === null) return;
      this.#open.push(record);
      return;
    }
    for (const key of record.keys!) Object.defineProperty(record.owner, key, { writable: true });
    this.#openCounts.set(record.name, (this.#openCounts.get(record.name) ?? 0) + 1);
    record.open = true;
    this.#open.push(record);
  }

  /** What a kind holds at `key` now (a set's member is its key); `undefined` once it is gone. */
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- EVIDENCE: invariant: a stored value as stored, which the shape walk then checks.
  #current(made: Made, key: unknown): unknown {
    const { holder } = made;
    switch (made.kind) {
      case "map":
        return Map.prototype.has.call(holder, key)
          ? Map.prototype.get.call(holder, key)
          : undefined;
      case "weakMap":
        // EVIDENCE: invariant: a weak map's stored key is an object.
        return WeakMap.prototype.get.call(holder, key as object);
      case "set":
        return Set.prototype.has.call(holder, key) ? key : undefined;
      case "weakSet":
        // EVIDENCE: invariant: a weak set's stored member is an object.
        return WeakSet.prototype.has.call(holder, key as object) ? key : undefined;
      default: {
        // EVIDENCE: invariant: a maker's key is a string or a symbol of its own target.
        const descriptor = Object.getOwnPropertyDescriptor(holder, key as PropertyKey);
        return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
      }
    }
  }

  /**
   * Whether `root` is of an admitted shape, walked through plain data by descriptors (no getter, no iterator run); with
   * `seal`, plain data not frozen yet is frozen. A shape outside the closed list is refused.
   */
  #admit(root: unknown, label: string, seal: boolean): void {
    // (the common cases, a primitive or a value already admitted, without a walk)
    if (typeof root !== "object" || root === null) {
      if (typeof root !== "function" || this.#registered.has(root)) return;
    } else if (this.#registered.has(root) || this.#sealed.has(root)) return;
    const stack: (readonly [unknown, string])[] = [[root, label]];
    const seen = new Set<object>();
    while (stack.length > 0) {
      const [value, path] = stack.pop()!;
      if (typeof value === "function" && !this.#registered.has(value)) {
        this.#refuse(`a function at ${path}, whose captures are not registered`);
        continue;
      }
      if (typeof value !== "object" || value === null) continue;
      if (seen.has(value) || this.#registered.has(value) || this.#sealed.has(value)) continue;
      seen.add(value);
      const prototype: unknown = Object.getPrototypeOf(value);
      if (prototype === Array.prototype || PLAIN.has(prototype)) {
        for (const key of Reflect.ownKeys(value)) {
          const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
          if (!("value" in descriptor)) {
            this.#refuse(`an accessor \`${String(key)}\` at ${path}`);
            continue;
          }
          if (key === "length" && prototype === Array.prototype) continue;
          stack.push([descriptor.value, `${path}.${String(key)}`]);
        }
        if (seal) {
          if (!Object.isFrozen(value)) Object.freeze(value);
          this.#sealed.add(value);
          this.#sealedCount += 1;
        }
        continue;
      }
      if (NATIVE_COLLECTIONS.has(prototype))
        this.#refuse(
          `a native ${className(value)} at ${path}: make it through \`Retained\` where it is created`,
        );
      else if (ArrayBuffer.isView(value)) {
        if (![...TYPED_ENTRIES.keys()].some((entry) => path.startsWith(entry)))
          this.#refuse(`a typed array at ${path}, under no entry of TYPED_ENTRIES`);
        else if (seal && !this.#typedSeen.has(value)) {
          // (its elements alone: an own field beside them is refused, and none is added later)
          if (Reflect.ownKeys(value).some((key) => typeof key === "symbol" || !/^\d+$/u.test(key)))
            this.#refuse(`a typed array with own fields beside its elements at ${path}`);
          Object.preventExtensions(value);
          this.#typedSeen.add(value);
          const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
          this.#typed.push({ view: value, bytes, path });
        }
      } else if (!IDENTITY_CLASSES.has(constructorOf(value)))
        this.#refuse(
          `an instance of ${className(value)}, a class not in IDENTITY_CLASSES, at ${path}`,
        );
    }
  }
}
