/*
 * #1072 step 1b: the passive recorder of the type core's retained state (`src/type-inference/core/retained/retained.ts`).
 *
 * What it guarantees, and nothing stronger: it detects an unrecorded change, observable by value at a run switch, to an
 * entry of its domain. An entry changed between two run switches must have been written in that run, through a
 * retained collection's own `set`, `add`, `delete` or `clear` or an `amend` of an object the entry reaches (or of its
 * owner); else it is a violation. A write undone before the run switch, state held only by a closure, and an object of
 * a class compared by identity (`IDENTITY_CLASSES`) changed in place are outside it. It does not replace validity or
 * read tracking, and it changes no answer and no charge: it reads retained state, never writes it.
 *
 * Its domain, and how each kind of state enters it:
 * - a collection made through `Retained` (a field's, a payload's, a module's capture through `retainedModule`): its
 *   membership is one entry, each key's value one entry;
 * - an owner registered through `Retained.owner`: each own enumerable field (string- or symbol-keyed) is an entry, and
 *   each private field its `hidden` gives; the names of its fields are one more entry;
 * - a weak collection made through `Retained`: made here as one that keeps its keys, so its entries can be listed.
 * An entry's value is fingerprinted by value through plain objects and the built-ins of exact prototype (arrays, typed
 * arrays, native maps and sets, each with its own enumerable fields), every field read through its descriptor; a
 * retained collection or owner met inside it is a reference (it is compared as its own entries). A function is taken
 * by identity. Anything else is the conservative default: an accessor is a violation and is never called, a native
 * weak collection is a violation (its entries cannot be listed), and an instance of a class not in `IDENTITY_CLASSES`
 * is a violation too. The one accessor read is one a registered owner's `hidden` gives by name: that `hidden` is code
 * the owner states reads passively (`CorePass`'s getters, which give owners made after it), trusted, not checked.
 *
 * Outside the domain in #1072 1b, by name: the admission's own state (`Admission`, `core/admission/`, `Touches`);
 * narrowing's indexes (`NarrowingIndex` and its module capture, `GuardIndex`'s narrowing queries); the questions' driver
 * (`Consumers`); what a query gathers in `contract/objects.ts` and a run's flow in `contract/contributions.ts` (the
 * solver's records); the result made after the analysis (`check-result/`, `CoreAnswers`, `ContractDescriptors`). The
 * lint's `OUTSIDE` and `TOP_LEVEL` give each reason; every other file of the type core is checked.
 *
 * The fingerprint is a detached string hash computed at the run switch (object identities as this recorder's own ids),
 * never the live object.
 */
import { WorkLedger } from "../../src/type-inference/core/budget.js";
import { IngressGraph } from "../../src/type-inference/core/items.js";
import { CoreProgram } from "../../src/type-inference/core/program.js";
import type { RetainedRecorder } from "../../src/type-inference/core/retained/retained.js";
import { Solver } from "../../src/type-inference/core/solver.js";

/** A negative control's marker (`tests/type-core/retained-recorder.test.ts`): a listed class of no other use. */
export class RecorderProbe {}

/** A listed class: one taken by identity. */
interface IdentityClass {
  readonly name: string;
  /** Why a later run cannot observe a change in one of its instances through retained state. */
  readonly reason: string;
  /** Whether the reason is a test: the `census` option walks its instances by value. */
  readonly census: boolean;
}

/**
 * The classes whose instances an entry's value takes by identity, by the class itself (never by its name), each with
 * its reason. An instance of any other class met in retained state fails the recorder, a subclass of a listed class or
 * of a native collection included.
 */
const IDENTITY_CLASSES: ReadonlyMap<unknown, IdentityClass> = new Map<unknown, IdentityClass>([
  [
    Solver,
    {
      name: "Solver",
      reason:
        "the solver's own records: a run reads them through solver reads, which the rule's reads govern, never as retained data",
      census: false,
    },
  ],
  [
    WorkLedger,
    {
      name: "WorkLedger",
      reason:
        "the work ledger: every charge changes it by design, and a stop reads it under the resource rule, not as retained data",
      census: false,
    },
  ],
  [
    IngressGraph,
    {
      name: "IngressGraph",
      reason:
        "the item scope's ingress cells: every run that makes an item may add one, as every charge adds to the ledger; an item names its cells, and items compare by their own signature",
      census: false,
    },
  ],
  [
    CoreProgram,
    {
      name: "CoreProgram",
      reason:
        "the program, indexed before the first pass and read by every pass: the census run finds no change",
      census: true,
    },
  ],
  [
    RecorderProbe,
    {
      name: "RecorderProbe",
      reason: "a negative control's own marker, never changed",
      census: false,
    },
  ],
]);

/** The prototypes whose instances are walked by value: plain data, by exact prototype only. */
const PLAIN = new Set<unknown>([Object.prototype, null]);
const TYPED = new Set<unknown>(
  [
    Int8Array,
    Uint8Array,
    Uint8ClampedArray,
    Int16Array,
    Uint16Array,
    Int32Array,
    Uint32Array,
    Float16Array,
    Float32Array,
    Float64Array,
    BigInt64Array,
    BigUint64Array,
    DataView,
  ].map((type) => type.prototype),
);

/** One run's marks: the entries its collections' writes named, and the objects it amended. */
interface Marks {
  readonly written: Set<string>;
  readonly amended: WeakSet<WeakKey>;
  /** The objects of `amended` in order, so a window's runs' marks can be joined (`every`). */
  readonly list: WeakKey[];
}

interface Registered {
  readonly id: number;
  readonly name: string;
}

/** A retained collection made here: it names its writes to the recorder. */
interface Recording extends Registered {
  /** Its membership as it stands: each key, a map's value at it, and whether it is a map's (a keyed entry). */
  list(): Iterable<readonly [unknown, unknown, boolean]>;
}

interface OwnerRecord extends Registered {
  /** The owner's fields, its private ones that hold retained state too; `null` once it is gone. */
  readonly fields: () => readonly (readonly [string, unknown])[] | null;
  /** Whether the run's marks amend the owner itself. */
  readonly amendedBy: (amended: WeakSet<WeakKey>) => boolean;
}

/** A recorder's findings: each violation once per entry and run, and the writes made outside a solver run. */
export interface RecorderReport {
  readonly violations: readonly string[];
  /** Writes outside any solver run, by owner name and site, with their counts. */
  readonly outside: ReadonlyMap<string, number>;
  /** The comparisons made (`every`), the last one `report`'s. */
  readonly checkpoints: number;
  /** The run switches heard. */
  readonly switches: number;
  /** The entries compared at the last checkpoint. */
  readonly entries: number;
  /** Classes compared by identity, with the times they were met. */
  readonly identities: ReadonlyMap<string, number>;
  /**
   * What the run switches saw change, by owner field (`Owner.field`, `Owner's fields`) and by collection's name: the
   * changes a collection's own write recorded and those an `amend` recorded; a name compared and never changed has
   * both zero.
   */
  readonly exercised: ReadonlyMap<string, Exercised>;
}

/** A value's fingerprint and whether it reaches an object the run amended (`Recorder.#value`). */
interface Fingerprint {
  readonly hash: string;
  readonly amended: boolean;
}

/** One part of an object's fingerprint: a text of its own, or a child walked in its place. */
type Item =
  | { readonly text: string; readonly child?: undefined }
  | { readonly text?: undefined; readonly child: unknown };

/** An object on the walk's stack: its parts so far, and its next item (`Recorder.#value`). */
interface Frame {
  readonly value: object;
  readonly items: readonly Item[];
  at: number;
  readonly parts: string[];
  reached: boolean;
}

/** The recorded changes of one owner field or collection (`RecorderReport.exercised`). */
export interface Exercised {
  written: number;
  amended: number;
}

/** A 53-bit hash of a string (cyrb53), as a short text. */
function hashText(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** The first stack frame outside the recorder and the retained module: where a write was made. */
function siteOf(stack: string | undefined): string {
  for (const line of (stack ?? "").split("\n").slice(1)) {
    if (line.includes("retained-recorder") || line.includes("retained/retained")) continue;
    const at = /\(?([^()\s]+):(\d+):\d+\)?$/.exec(line.trim());
    if (at !== null) return `${at[1]!.replace(/^.*\/(src|dist|tests)\//, "$1/")}:${at[2]}`;
  }
  return "unknown";
}

/** A recorder's options: `locate` names, with each unrecorded change, the path within the entry where it stands. */
export interface RecorderOptions {
  readonly locate?: boolean;
  /**
   * Compares at every `every`-th run switch and at the last (`report`), the marks of every run in the switches between
   * counting for the next comparison: an unmarked change is still found, but not which switch made it, and a change
   * undone within the window, or marked in it by another run, is not. 1, every switch, unless given (the sweep's cost
   * bound, #1072 1b R12).
   */
  readonly every?: number;
  /** Walks the instances of the identity classes marked `census` by value, so a change in one is named. */
  readonly census?: boolean;
}

export class Recorder implements RetainedRecorder {
  readonly #locate: boolean;
  readonly #census: boolean;
  readonly #every: number;
  /** The runs whose intervals ended at the switches since the last comparison (`every`). */
  readonly #window = new Set<WeakKey>();
  #since = 0;
  #switches = 0;
  /** Each object's fingerprint at the last checkpoint, kept only where `locate` asks for it. */
  #lastMemo = new Map<WeakKey, Fingerprint>();
  readonly #ids = new WeakMap<WeakKey, number>();
  readonly #symbols = new Map<symbol, number>();
  #next = 1;
  readonly #collections: WeakRef<Recording & object>[] = [];
  readonly #owners: OwnerRecord[] = [];
  /** Each registered collection and owner, by itself: met inside a value, it is a reference. */
  readonly #registered = new WeakMap<WeakKey, string>();
  /** The current run, and its marks; an interval outside any solver run is a run of its own. */
  #run: WeakKey = { outside: true };
  #outside = true;
  readonly #marks = new WeakMap<WeakKey, Marks>();
  /** Each entry's fingerprint at the last checkpoint. */
  #before = new Map<string, string>();
  readonly #violations: string[] = [];
  readonly #seen = new Set<string>();
  readonly #outsideWrites = new Map<string, number>();
  readonly #identities = new Map<string, number>();
  readonly #exercised = new Map<string, Exercised>();
  #checkpoints = 0;
  #entries = 0;
  /** Whether the next checkpoint only takes fingerprints (the first, and the one after a callback is installed). */
  #fresh = true;

  public constructor(options: RecorderOptions = {}) {
    this.#locate = options.locate === true;
    this.#census = options.census === true;
    this.#every = options.every ?? 1;
  }

  public report(): RecorderReport {
    this.checkpoint();
    return {
      violations: this.#violations,
      outside: this.#outsideWrites,
      checkpoints: this.#checkpoints,
      switches: this.#switches,
      entries: this.#entries,
      identities: this.#identities,
      exercised: this.#exercised,
    };
  }

  #id(value: WeakKey): number {
    let id = this.#ids.get(value);
    if (id === undefined) this.#ids.set(value, (id = this.#next++));
    return id;
  }

  #marksOf(run: WeakKey): Marks {
    let marks = this.#marks.get(run);
    if (marks === undefined)
      this.#marks.set(run, (marks = { written: new Set(), amended: new WeakSet(), list: [] }));
    return marks;
  }

  /** `target` marked in the current run. */
  #mark<T extends object>(target: T): void {
    const marks = this.#marksOf(this.#run);
    if (marks.amended.has(target)) return;
    marks.amended.add(target);
    marks.list.push(target);
  }

  /** The marks of several runs as one (`every`). */
  #joined(runs: readonly WeakKey[]): Marks {
    const joined: Marks = { written: new Set(), amended: new WeakSet(), list: [] };
    for (const run of runs) {
      const marks = this.#marksOf(run);
      for (const entry of marks.written) joined.written.add(entry);
      for (const target of marks.list) joined.amended.add(target);
    }
    return joined;
  }

  #outsideWrite(name: string): void {
    if (!this.#outside) return;
    const key = `${name} at ${siteOf(new Error().stack)}`;
    this.#outsideWrites.set(key, (this.#outsideWrites.get(key) ?? 0) + 1);
  }

  /** A collection's write of `key`'s entry (and its membership's, where it changes). */
  #wrote(collection: Registered, key: unknown, membership: boolean): void {
    const written = this.#marksOf(this.#run).written;
    written.add(this.#keyEntry(collection.id, key));
    if (membership) written.add(`${collection.id}:#`);
    this.#outsideWrite(collection.name);
  }

  #keyEntry(collection: number, key: unknown): string {
    return `${collection}:${this.#atom(key)}`;
  }

  /** A key's or a primitive's text: its type and value, an object's or a symbol's identity. */
  #atom(value: unknown): string {
    switch (typeof value) {
      case "string":
        return JSON.stringify(value);
      case "number":
        // (negative zero is a value of its own: `String` would print it as `0`)
        return Object.is(value, -0) ? "n-0" : `n${String(value)}`;
      case "boolean":
      case "bigint":
        return `${(typeof value)[0]}${String(value)}`;
      case "undefined":
        return "undefined";
      case "symbol": {
        let id = this.#symbols.get(value);
        if (id === undefined) this.#symbols.set(value, (id = this.#next++));
        return `y${id}`;
      }
      default:
        // EVIDENCE: invariant: past the primitive cases, `value` is an object or a function.
        return value === null ? "null" : `o${this.#id(value as WeakKey)}`;
    }
  }

  #register<T extends WeakKey>(made: T & Recording): T {
    this.#collections.push(new WeakRef(made));
    this.#registered.set(made, `R${made.id}`);
    // (made by the current run: its membership is that run's write)
    this.#marksOf(this.#run).written.add(`${made.id}:#`);
    return made;
  }

  /** A collection's write, as its methods hear it. */
  #writer(): (collection: Registered, key: unknown, membership: boolean) => void {
    return (collection, key, membership) => this.#wrote(collection, key, membership);
  }

  public map<K, V>(name: string, entries: Iterable<readonly [K, V]> | null): Map<K, V> {
    const wrote = this.#writer();
    const id = this.#next++;
    class RecordingMap extends Map<K, V> implements Recording {
      readonly id = id;
      readonly name = name;
      public override set(key: K, value: V): this {
        wrote(this, key, !super.has(key));
        return super.set(key, value);
      }
      public override delete(key: K): boolean {
        if (super.has(key)) wrote(this, key, true);
        return super.delete(key);
      }
      public override clear(): void {
        for (const key of super.keys()) wrote(this, key, true);
        super.clear();
      }
      public *list(): Iterable<readonly [unknown, unknown, boolean]> {
        for (const [key, value] of super.entries()) yield [key, value, true];
      }
    }
    const made = new RecordingMap();
    for (const [key, value] of entries ?? []) made.set(key, value);
    return this.#register(made);
  }

  public set<T>(name: string, values: Iterable<T> | null): Set<T> {
    const wrote = this.#writer();
    const id = this.#next++;
    class RecordingSet extends Set<T> implements Recording {
      readonly id = id;
      readonly name = name;
      public override add(value: T): this {
        if (!super.has(value)) wrote(this, value, true);
        return super.add(value);
      }
      public override delete(value: T): boolean {
        if (super.has(value)) wrote(this, value, true);
        return super.delete(value);
      }
      public override clear(): void {
        for (const value of super.values()) wrote(this, value, true);
        super.clear();
      }
      public *list(): Iterable<readonly [unknown, unknown, boolean]> {
        for (const value of super.values()) yield [value, undefined, false];
      }
    }
    const made = new RecordingSet();
    for (const value of values ?? []) made.add(value);
    return this.#register(made);
  }

  public weakMap<K extends object, V>(name: string): WeakMap<K, V> {
    const wrote = this.#writer();
    const id = this.#next++;
    class RecordingWeakMap extends WeakMap<K, V> {
      readonly id = id;
      readonly name = name;
      /** Its keys, kept so its entries can be listed (test-only: it holds them alive). */
      readonly keys = new Set<K>();
      public override set(key: K, value: V): this {
        wrote(this, key, !this.keys.has(key));
        this.keys.add(key);
        return super.set(key, value);
      }
      public override delete(key: K): boolean {
        if (this.keys.delete(key)) wrote(this, key, true);
        return super.delete(key);
      }
      public *list(): Iterable<readonly [unknown, unknown, boolean]> {
        for (const key of this.keys) yield [key, super.get(key), true];
      }
    }
    return this.#register(new RecordingWeakMap());
  }

  public weakSet<T extends object>(name: string): WeakSet<T> {
    const wrote = this.#writer();
    const id = this.#next++;
    class RecordingWeakSet extends WeakSet<T> implements Recording {
      readonly id = id;
      readonly name = name;
      /** Its members, kept so they can be listed (test-only: it holds them alive). */
      readonly members = new Set<T>();
      public override add(value: T): this {
        if (!this.members.has(value)) wrote(this, value, true);
        this.members.add(value);
        return super.add(value);
      }
      public override delete(value: T): boolean {
        if (this.members.delete(value)) wrote(this, value, true);
        return super.delete(value);
      }
      public *list(): Iterable<readonly [unknown, unknown, boolean]> {
        for (const value of this.members) yield [value, undefined, false];
      }
    }
    return this.#register(new RecordingWeakSet());
  }

  public owner<T extends object>(
    owner: T,
    name: string,
    hidden: ((owner: T) => Readonly<Record<string, unknown>>) | null,
  ): void {
    const id = this.#next++;
    const ref = new WeakRef(owner);
    this.#owners.push({
      id,
      name,
      fields: () => {
        const held = ref.deref();
        if (held === undefined) return null;
        // (an own accessor its `hidden` gives by name is the owner's declared read: its value is that one)
        const given = hidden === null ? {} : hidden(held);
        const fields: (readonly [string, unknown])[] = this.#ownFields(
          held,
          new Set(Object.keys(given)),
        );
        for (const [field, value] of Object.entries(given)) fields.push([`#${field}`, value]);
        return fields;
      },
      amendedBy: (amended) => {
        const held = ref.deref();
        return held !== undefined && amended.has(held);
      },
    });
    this.#registered.set(owner, `O${id}`);
    this.#mark(owner);
  }

  public amend<T extends object>(target: T): void {
    this.#mark(target);
    this.#outsideWrite(this.#registered.get(target) ?? className(target));
  }

  public run<T extends object>(run: T | null): void {
    const next = run ?? { outside: true };
    if (run === this.#run || (run === null && this.#outside)) return;
    this.#switches += 1;
    this.#since += 1;
    if (this.#since >= this.#every) this.checkpoint();
    else this.#window.add(this.#run);
    this.#run = next;
    this.#outside = run === null;
  }

  /**
   * Fingerprints every entry and compares each with the last checkpoint's: a changed one the run that just ended did
   * not mark is a violation.
   */
  public checkpoint(): void {
    this.#checkpoints += 1;
    // (the marks of the run that just ended, and of each run whose interval ended at a switch not compared)
    this.#window.add(this.#run);
    const marks =
      this.#window.size === 1 ? this.#marksOf(this.#run) : this.#joined([...this.#window]);
    this.#window.clear();
    this.#since = 0;
    const memo = new Map<WeakKey, Fingerprint>();
    const after = new Map<string, string>();
    const changed = (
      entry: string,
      hash: string,
      covered: () => boolean,
      label: string,
      value: unknown,
      tally: string,
    ): void => {
      after.set(entry, hash);
      let seen = this.#exercised.get(tally);
      if (seen === undefined) this.#exercised.set(tally, (seen = { written: 0, amended: 0 }));
      const before = this.#before.get(entry);
      if (this.#fresh || before === undefined || before === hash) return;
      if (marks.written.has(entry)) {
        seen.written += 1;
        return;
      }
      if (covered()) {
        seen.amended += 1;
        return;
      }
      const where = this.#locate ? ` (changed at ${this.#where(value, memo)})` : "";
      const text = `unrecorded change: ${label}${where}`;
      if (!this.#seen.has(text)) {
        this.#seen.add(text);
        this.#violations.push(text);
      }
    };
    for (const ref of this.#collections) {
      const collection = ref.deref();
      if (collection === undefined) continue;
      const listed = [...listOf(collection)];
      changed(
        `${collection.id}:#`,
        hashText(listed.map(([key]) => this.#atom(key)).join(",")),
        () => false,
        `${collection.name}'s membership`,
        null,
        collection.name,
      );
      // (a map's value at each key, a set's member itself: each its own entry, by value)
      for (const [key, value, keyed] of listed) {
        const held = keyed ? value : key;
        const node = this.#value(held, memo, marks.amended);
        changed(
          this.#keyEntry(collection.id, key),
          node.hash,
          () => node.amended,
          `${collection.name} at ${this.#atom(key)}`,
          held,
          collection.name,
        );
      }
    }
    for (const record of this.#owners) {
      const fields = record.fields();
      if (fields === null) continue;
      const ownerAmended = record.amendedBy(marks.amended);
      // (its fields' names: one more entry, so a field added or removed is a change too)
      changed(
        `O${record.id}:#`,
        hashText(fields.map(([field]) => JSON.stringify(field)).join(",")),
        () => ownerAmended,
        `${record.name}'s fields`,
        null,
        `${record.name}'s fields`,
      );
      for (const [field, value] of fields) {
        const node = this.#value(value, memo, marks.amended);
        changed(
          `O${record.id}.${field}`,
          node.hash,
          () => ownerAmended || node.amended,
          `${record.name}.${field}`,
          value,
          `${record.name}.${field}`,
        );
      }
    }
    this.#entries = after.size;
    this.#before = after;
    if (this.#locate) this.#lastMemo = memo;
    this.#fresh = false;
  }

  /**
   * A value's fingerprint, and whether it reaches an object the run amended: walked depth first with a stack of its
   * own, so a value of any depth fits, each object's parts its items' (`#items`) in order.
   */
  #value(root: unknown, memo: Map<WeakKey, Fingerprint>, amended: WeakSet<WeakKey>): Fingerprint {
    const leaf = this.#leaf(root, memo);
    if (leaf !== null) return leaf;
    const onPath = new Set<object>();
    const frames: Frame[] = [];
    const open = <T extends object>(value: T): void => {
      onPath.add(value);
      frames.push({
        value,
        items: this.#items(value),
        at: 0,
        parts: [],
        reached: amended.has(value),
      });
    };
    // EVIDENCE: invariant: `#leaf` answers every primitive and function, so `root` is an object here.
    open(root as object);
    let result: Fingerprint | null = null;
    while (frames.length > 0) {
      const frame = frames.at(-1)!;
      const item = frame.items[frame.at];
      if (item === undefined) {
        frames.pop();
        onPath.delete(frame.value);
        const node = { hash: hashText(frame.parts.join("|")), amended: frame.reached };
        memo.set(frame.value, node);
        const parent = frames.at(-1);
        if (parent === undefined) result = node;
        else {
          parent.parts.push(node.hash);
          parent.reached ||= node.amended;
        }
        continue;
      }
      frame.at += 1;
      if (item.text !== undefined) {
        frame.parts.push(item.text);
        continue;
      }
      const known = this.#leaf(item.child, memo);
      if (known !== null) {
        frame.parts.push(known.hash);
        frame.reached ||= known.amended;
        continue;
      }
      // EVIDENCE: invariant: `#leaf` answers every primitive and function, so the child is an object here.
      const child = item.child as object;
      // (an object on the walk's own path is a cycle: its identity only)
      if (onPath.has(child)) frame.parts.push(`^${this.#id(child)}`);
      else open(child);
    }
    return result!;
  }

  /** A value's fingerprint where no walk is needed: a primitive, a function, a registered object, or one walked already. */
  #leaf(value: unknown, memo: Map<WeakKey, Fingerprint>): Fingerprint | null {
    if ((typeof value !== "object" && typeof value !== "function") || value === null)
      return { hash: this.#atom(value), amended: false };
    if (typeof value === "function") return { hash: `F${this.#id(value)}`, amended: false };
    // (a retained collection or owner met inside a value is compared as its own entries: here its identity only, so its
    // mark covers its own entries, never this one's)
    const reference = this.#registered.get(value);
    if (reference !== undefined) return { hash: reference, amended: false };
    return memo.get(value) ?? null;
  }

  /** An object's parts in order: its kind's texts and the children walked after them (`#value`). */
  #items<T extends object>(value: T): Item[] {
    const items: Item[] = [];
    const prototype: unknown = Object.getPrototypeOf(value);
    const listed = IDENTITY_CLASSES.get(constructorOf(value));
    // (a built-in's own fields beyond its contents are walked too: an array's elements are its index fields)
    const fields = (indices: boolean): void => {
      for (const [key, field] of this.#ownFields(value)) {
        if (!indices && INDEX.test(key)) continue;
        items.push({ text: JSON.stringify(key) }, { child: field });
      }
    };
    if (prototype === Array.prototype) {
      // EVIDENCE: invariant: an object whose prototype is `Array.prototype` is an array.
      const { length } = value as unknown[];
      items.push({ text: `[${length}` });
      fields(true);
    } else if (TYPED.has(prototype)) {
      // (a typed array's or a data view's bytes are plain data)
      // EVIDENCE: invariant: an object whose prototype is a built-in view's is that view.
      const view = value as ArrayBufferView;
      items.push({
        text: `T${new Uint8Array(view.buffer, view.byteOffset, view.byteLength).join(",")}`,
      });
      fields(false);
    } else if (prototype === Map.prototype) {
      items.push({ text: "M" });
      // EVIDENCE: invariant: an object whose prototype is `Map.prototype` is a map.
      for (const [key, element] of value as Map<unknown, unknown>)
        items.push({ child: key }, { child: element });
      fields(true);
    } else if (prototype === Set.prototype) {
      items.push({ text: "S" });
      // EVIDENCE: invariant: an object whose prototype is `Set.prototype` is a set.
      for (const element of value as Set<unknown>) items.push({ child: element });
      fields(true);
    } else if (prototype === WeakMap.prototype || prototype === WeakSet.prototype) {
      this.#violation(`a native weak collection in retained state, which cannot be listed`);
      items.push({ text: `W${this.#id(value)}` });
    } else if (PLAIN.has(prototype) || (this.#census && listed?.census === true)) {
      items.push({ text: "{" });
      fields(true);
    } else {
      const name = listed?.name ?? className(value);
      this.#identities.set(name, (this.#identities.get(name) ?? 0) + 1);
      if (listed === undefined)
        this.#violation(
          `an instance of ${name}, a class not in IDENTITY_CLASSES, in retained state`,
        );
      items.push({ text: `C${name}#${this.#id(value)}` });
    }
    return items;
  }

  /**
   * Where within `value` its change stands: down the children whose fingerprints changed since the last checkpoint, to
   * the object whose own fields changed (`locate`).
   */
  #where(start: unknown, memo: Map<WeakKey, { readonly hash: string }>): string {
    let value = start;
    let path = "";
    const seen = new Set<unknown>();
    for (;;) {
      if (typeof value !== "object" || value === null) return path || "(the value itself)";
      seen.add(value);
      const children: [string, unknown][] = [
        ...(value instanceof Map
          ? [...value].map(([key, each]): [string, unknown] => [`.get(${this.#atom(key)})`, each])
          : value instanceof Set
            ? [...value].map((each, index): [string, unknown] => [`{${index}}`, each])
            : []),
        ...this.#ownFields(value).map(([key, each]): [string, unknown] => [`.${key}`, each]),
      ];
      const next = children.find(([, child]) => {
        if (
          typeof child !== "object" ||
          child === null ||
          this.#registered.has(child) ||
          seen.has(child)
        )
          return false;
        const now = memo.get(child)?.hash;
        const then = this.#lastMemo.get(child)?.hash;
        return now !== undefined && then !== undefined && now !== then;
      });
      if (next === undefined) return `${path || "(the value)"} (${className(value)})`;
      path += next[0];
      value = next[1];
    }
  }

  /**
   * An object's own enumerable data fields, string-keyed and symbol-keyed (`[y<id>]`), in order, read through their
   * descriptors: no getter is called. An own accessor is a violation (the conservative default: a getter's value is not
   * data the walk may compute), unless `declared` names it: a registered owner's `hidden` gives it by name, and the
   * owner's `hidden` is trusted to read it passively.
   */
  #ownFields<T extends object>(
    value: T,
    declared: ReadonlySet<string> = new Set(),
  ): (readonly [string, unknown])[] {
    const fields: (readonly [string, unknown])[] = [];
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor?.enumerable !== true) continue;
      const name = typeof key === "symbol" ? `[${this.#atom(key)}]` : key;
      if ("value" in descriptor) fields.push([name, descriptor.value]);
      else if (!declared.has(name))
        this.#violation(`an accessor \`${name}\` of ${className(value)} in retained state`);
    }
    return fields;
  }

  #violation(text: string): void {
    if (this.#seen.has(text)) return;
    this.#seen.add(text);
    this.#violations.push(text);
  }
}

/** A class, as its prototype's `constructor` gives it. */
interface Made {
  readonly name: string;
}

/** An array index's or a typed array's element's key. */
const INDEX = /^(?:0|[1-9]\d*)$/;

/**
 * An object's class: its prototype's own `constructor` where that is a data field holding a function, read through its
 * descriptor (no getter is called); else none.
 */
function constructorOf(value: WeakKey): Made | undefined {
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype === null) return undefined;
  // EVIDENCE: invariant: a prototype is an object, so it can hold a descriptor.
  const descriptor = Object.getOwnPropertyDescriptor(prototype as object, "constructor");
  // EVIDENCE: invariant: `typeof` has just found the data field's value a function.
  return descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "function"
    ? (descriptor.value as Made)
    : undefined;
}

/** An object's class's name, as its constructor gives it (`constructorOf`); `anonymous` without one. */
function className(value: WeakKey): string {
  return constructorOf(value)?.name ?? "anonymous";
}

/** A recording collection's membership and values. */
function listOf(collection: Recording): Iterable<readonly [unknown, unknown, boolean]> {
  return collection.list();
}
