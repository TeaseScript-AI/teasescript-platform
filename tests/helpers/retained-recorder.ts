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
 * - an owner registered through `Retained.owner`: each own enumerable field is an entry, and each private field its
 *   `hidden` gives;
 * - a weak collection made through `Retained`: made here as one that keeps its keys, so its entries can be listed.
 * An entry's value is fingerprinted by value through arrays, plain objects, and native maps and sets; a retained
 * collection or owner met inside it is a reference (it is compared as its own entries). A function is taken by
 * identity. Anything else is the conservative default: a native weak collection is a violation (its entries cannot be
 * listed), and an instance of a class not in `IDENTITY_CLASSES` is a violation too.
 *
 * The fingerprint is a detached string hash computed at the run switch (object identities as this recorder's own ids),
 * never the live object.
 */
import type { RetainedRecorder } from "../../src/type-inference/core/retained/retained.js";

/**
 * The classes whose instances an entry's value takes by identity, each with why a later run cannot observe a change in
 * one through retained state: `census` where the reason is a test (`Recorder`'s `census` option walks them by value).
 * A class met in retained state and missing here fails the recorder.
 */
export const IDENTITY_CLASSES: ReadonlyMap<
  string,
  { readonly reason: string; readonly census: boolean }
> = new Map([
  [
    "Solver",
    {
      reason:
        "the solver's own records: a run reads them through solver reads, which the rule's reads govern, never as retained data",
      census: false,
    },
  ],
  [
    "WorkLedger",
    {
      reason:
        "the work ledger: every charge changes it by design, and a stop reads it under the resource rule, not as retained data",
      census: false,
    },
  ],
  [
    "IngressGraph",
    {
      reason:
        "the item scope's ingress cells: every run that makes an item may add one, as every charge adds to the ledger; an item names its cells, and items compare by their own signature",
      census: false,
    },
  ],
  [
    "CoreProgram",
    {
      reason:
        "the program, indexed before the first pass and read by every pass: the census run finds no change",
      census: true,
    },
  ],
  [
    "NestedSpans",
    {
      reason:
        "built whole in its constructor: its private fields are written nowhere else (src/type-inference/core/exact-path.ts)",
      census: false,
    },
  ],
  [
    "RecorderProbe",
    {
      reason: "a negative control's own marker (tests/type-core/retained-recorder.test.ts)",
      census: false,
    },
  ],
]);

/** One run's marks: the entries its collections' writes named, and the objects it amended. */
interface Marks {
  readonly written: Set<string>;
  readonly amended: WeakSet<object>;
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
  readonly owner: WeakRef<object>;
  readonly hidden: ((owner: object) => Readonly<Record<string, unknown>>) | null;
}

/** A recorder's findings: each violation once per entry and run, and the writes made outside a solver run. */
export interface RecorderReport {
  readonly violations: readonly string[];
  /** Writes outside any solver run, by owner name and site, with their counts. */
  readonly outside: ReadonlyMap<string, number>;
  readonly checkpoints: number;
  /** The entries compared at the last checkpoint. */
  readonly entries: number;
  /** Classes compared by identity, with the times they were met. */
  readonly identities: ReadonlyMap<string, number>;
}

const PLAIN = new Set<unknown>([Object.prototype, null]);

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
  /** Walks the instances of the identity classes marked `census` by value, so a change in one is named. */
  readonly census?: boolean;
}

export class Recorder implements RetainedRecorder {
  readonly #locate: boolean;
  readonly #census: boolean;
  /** Each object's fingerprint at the last checkpoint, kept only where `locate` asks for it. */
  #lastMemo = new Map<object, { readonly hash: string; readonly amended: boolean }>();
  readonly #ids = new WeakMap<object, number>();
  readonly #symbols = new Map<symbol, number>();
  #next = 1;
  readonly #collections: WeakRef<Recording & object>[] = [];
  readonly #owners: OwnerRecord[] = [];
  /** Each registered collection and owner, by itself: met inside a value, it is a reference. */
  readonly #registered = new WeakMap<object, string>();
  /** The current run, and its marks; an interval outside any solver run is a run of its own. */
  #run: object = { outside: true };
  #outside = true;
  readonly #marks = new WeakMap<object, Marks>();
  /** Each entry's fingerprint at the last checkpoint. */
  #before = new Map<string, string>();
  readonly #violations: string[] = [];
  readonly #seen = new Set<string>();
  readonly #outsideWrites = new Map<string, number>();
  readonly #identities = new Map<string, number>();
  #checkpoints = 0;
  #entries = 0;
  /** Whether the next checkpoint only takes fingerprints (the first, and the one after a callback is installed). */
  #fresh = true;

  public constructor(options: RecorderOptions = {}) {
    this.#locate = options.locate === true;
    this.#census = options.census === true;
  }

  public report(): RecorderReport {
    this.checkpoint();
    return {
      violations: this.#violations,
      outside: this.#outsideWrites,
      checkpoints: this.#checkpoints,
      entries: this.#entries,
      identities: this.#identities,
    };
  }

  #id(object: object): number {
    let id = this.#ids.get(object);
    if (id === undefined) this.#ids.set(object, (id = this.#next++));
    return id;
  }

  #marksOf(run: object): Marks {
    let marks = this.#marks.get(run);
    if (marks === undefined)
      this.#marks.set(run, (marks = { written: new Set(), amended: new WeakSet() }));
    return marks;
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
        return value === null ? "null" : `o${this.#id(value as object)}`;
    }
  }

  #register<T extends object>(made: T & Recording): T {
    this.#collections.push(new WeakRef(made));
    this.#registered.set(made, `R${made.id}`);
    // (made by the current run: its membership is that run's write)
    this.#marksOf(this.#run).written.add(`${made.id}:#`);
    return made;
  }

  public map<K, V>(name: string, entries: Iterable<readonly [K, V]> | null): Map<K, V> {
    const recorder = this;
    const id = this.#next++;
    class RecordingMap extends Map<K, V> implements Recording {
      readonly id = id;
      readonly name = name;
      public override set(key: K, value: V): this {
        recorder.#wrote(this, key, !super.has(key));
        return super.set(key, value);
      }
      public override delete(key: K): boolean {
        if (super.has(key)) recorder.#wrote(this, key, true);
        return super.delete(key);
      }
      public override clear(): void {
        for (const key of super.keys()) recorder.#wrote(this, key, true);
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
    const made = this.#recordingSet<T>(name, Set) as Set<T> & Recording;
    for (const value of values ?? []) made.add(value);
    return this.#register(made);
  }

  public weakMap<K extends object, V>(name: string): WeakMap<K, V> {
    const recorder = this;
    const id = this.#next++;
    class RecordingWeakMap extends WeakMap<K, V> {
      readonly id = id;
      readonly name = name;
      /** Its keys, kept so its entries can be listed (test-only: it holds them alive). */
      readonly keys = new Set<K>();
      public override set(key: K, value: V): this {
        recorder.#wrote(this, key, !this.keys.has(key));
        this.keys.add(key);
        return super.set(key, value);
      }
      public override delete(key: K): boolean {
        if (this.keys.delete(key)) recorder.#wrote(this, key, true);
        return super.delete(key);
      }
      public *list(): Iterable<readonly [unknown, unknown, boolean]> {
        for (const key of this.keys) yield [key, super.get(key), true];
      }
    }
    return this.#register(new RecordingWeakMap());
  }

  public weakSet<T extends object>(name: string): WeakSet<T> {
    return this.#register(this.#recordingSet<T>(name, WeakSet) as WeakSet<T> & Recording);
  }

  #recordingSet<T>(name: string, base: typeof Set | typeof WeakSet): object {
    const recorder = this;
    const id = this.#next++;
    const members = new Set<T>();
    // EVIDENCE: invariant: `base` is `Set` or `WeakSet`, whose `add`, `has` and `delete` take one member.
    const Base = base as unknown as new () => {
      add(value: T): unknown;
      delete(value: T): boolean;
      clear?(): void;
    };
    class RecordingSet extends Base {
      readonly id = id;
      readonly name = name;
      public override add(value: T): this {
        if (!members.has(value)) recorder.#wrote(this, value, true);
        members.add(value);
        super.add(value);
        return this;
      }
      public override delete(value: T): boolean {
        if (members.delete(value)) recorder.#wrote(this, value, true);
        return super.delete(value);
      }
      public override clear(): void {
        for (const value of members) recorder.#wrote(this, value, true);
        members.clear();
        super.clear?.();
      }
      public list(): Iterable<readonly [unknown, unknown, boolean]> {
        return [...members].map((value) => [value, undefined, false] as const);
      }
    }
    return new RecordingSet();
  }

  public owner(
    owner: object,
    name: string,
    hidden: ((owner: object) => Readonly<Record<string, unknown>>) | null,
  ): void {
    const id = this.#next++;
    this.#owners.push({ id, name, owner: new WeakRef(owner), hidden });
    this.#registered.set(owner, `O${id}`);
    this.#marksOf(this.#run).amended.add(owner);
  }

  public amend(target: object): void {
    this.#marksOf(this.#run).amended.add(target);
    this.#outsideWrite(this.#registered.get(target) ?? (target.constructor?.name || "object"));
  }

  public run(run: object | null): void {
    const next = run ?? { outside: true };
    if (run === this.#run || (run === null && this.#outside)) return;
    this.checkpoint();
    this.#run = next;
    this.#outside = run === null;
  }

  /**
   * Fingerprints every entry and compares each with the last checkpoint's: a changed one the run that just ended did
   * not mark is a violation.
   */
  public checkpoint(): void {
    this.#checkpoints += 1;
    const marks = this.#marksOf(this.#run);
    const memo = new Map<object, { readonly hash: string; readonly amended: boolean }>();
    const after = new Map<string, string>();
    const changed = (
      entry: string,
      hash: string,
      covered: () => boolean,
      label: string,
      value: unknown,
    ): void => {
      after.set(entry, hash);
      const before = this.#before.get(entry);
      if (this.#fresh || before === undefined || before === hash) return;
      if (marks.written.has(entry) || covered()) return;
      const where = this.#locate ? ` (changed at ${this.#where(value, memo, "")})` : "";
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
      );
      for (const [key, value, keyed] of listed) {
        if (!keyed) continue;
        const node = this.#value(value, memo, marks.amended, []);
        changed(
          this.#keyEntry(collection.id, key),
          node.hash,
          () => node.amended,
          `${collection.name} at ${this.#atom(key)}`,
          value,
        );
      }
    }
    for (const record of this.#owners) {
      const owner = record.owner.deref();
      if (owner === undefined) continue;
      const fields: [string, unknown][] = Object.entries(owner);
      if (record.hidden !== null)
        for (const [field, value] of Object.entries(record.hidden(owner)))
          fields.push([`#${field}`, value]);
      const ownerAmended = marks.amended.has(owner);
      for (const [field, value] of fields) {
        const node = this.#value(value, memo, marks.amended, []);
        changed(
          `O${record.id}.${field}`,
          node.hash,
          () => ownerAmended || node.amended,
          `${record.name}.${field}`,
          value,
        );
      }
    }
    this.#entries = after.size;
    this.#before = after;
    if (this.#locate) this.#lastMemo = memo;
    this.#fresh = false;
  }

  /** A value's fingerprint, and whether it reaches an object the run amended. */
  #value(
    value: unknown,
    memo: Map<object, { readonly hash: string; readonly amended: boolean }>,
    amended: WeakSet<object>,
    stack: object[],
  ): { readonly hash: string; readonly amended: boolean } {
    if ((typeof value !== "object" && typeof value !== "function") || value === null)
      return { hash: this.#atom(value), amended: false };
    if (typeof value === "function") return { hash: `F${this.#id(value)}`, amended: false };
    // (a retained collection or owner met inside a value is compared as its own entries; here only its identity)
    const reference = this.#registered.get(value);
    if (reference !== undefined) return { hash: reference, amended: amended.has(value) };
    if (stack.includes(value)) return { hash: `^${this.#id(value)}`, amended: false };
    const known = memo.get(value);
    if (known !== undefined) return known;
    let reached = amended.has(value);
    const parts: string[] = [];
    const part = (child: unknown): void => {
      const node = this.#value(child, memo, amended, stack);
      reached ||= node.amended;
      parts.push(node.hash);
    };
    stack.push(value);
    const prototype: unknown = Object.getPrototypeOf(value);
    if (Array.isArray(value)) {
      parts.push("[");
      for (const element of value) part(element);
    } else if (ArrayBuffer.isView(value)) {
      // (a typed array's elements are plain data)
      parts.push(`T${String(value)}`);
    } else if (value instanceof Map) {
      parts.push("M");
      for (const [key, element] of value) {
        parts.push(this.#atom(key));
        part(element);
      }
    } else if (value instanceof Set) {
      parts.push("S");
      for (const element of value) part(element);
    } else if (value instanceof WeakMap || value instanceof WeakSet) {
      this.#violation(`a native weak collection in retained state, which cannot be listed`);
      parts.push(`W${this.#id(value)}`);
    } else if (
      PLAIN.has(prototype) ||
      (this.#census && IDENTITY_CLASSES.get(className(value))?.census === true)
    ) {
      parts.push("{");
      for (const [key, field] of Object.entries(value)) {
        parts.push(JSON.stringify(key));
        part(field);
      }
    } else {
      const name = className(value);
      this.#identities.set(name, (this.#identities.get(name) ?? 0) + 1);
      if (!IDENTITY_CLASSES.has(name))
        this.#violation(
          `an instance of ${name}, a class not in IDENTITY_CLASSES, in retained state`,
        );
      parts.push(`C${name}#${this.#id(value)}`);
    }
    stack.pop();
    const node = { hash: hashText(parts.join("|")), amended: reached };
    memo.set(value, node);
    return node;
  }

  /**
   * Where within `value` its change stands: down the children whose fingerprints changed since the last checkpoint, to
   * the object whose own fields changed (`locate`).
   */
  #where(value: unknown, memo: Map<object, { readonly hash: string }>, path: string): string {
    if (typeof value !== "object" || value === null) return path || "(the value itself)";
    const children: [string, unknown][] = Array.isArray(value)
      ? value.map((each, index) => [`[${index}]`, each])
      : value instanceof Map
        ? [...value].map(([key, each]) => [`.get(${this.#atom(key)})`, each])
        : value instanceof Set
          ? [...value].map((each, index) => [`{${index}}`, each])
          : Object.entries(value).map(([key, each]) => [`.${key}`, each]);
    for (const [step, child] of children) {
      if (typeof child !== "object" || child === null || this.#registered.has(child)) continue;
      const now = memo.get(child)?.hash;
      const then = this.#lastMemo.get(child)?.hash;
      if (now !== undefined && then !== undefined && now !== then)
        return this.#where(child, memo, path + step);
    }
    const name = (value.constructor as { name?: string } | undefined)?.name ?? "object";
    return `${path || "(the value)"} (${name})`;
  }

  #violation(text: string): void {
    if (this.#seen.has(text)) return;
    this.#seen.add(text);
    this.#violations.push(text);
  }
}

/** An object's class's name, as its constructor gives it. */
function className(value: object): string {
  return (value.constructor as { name?: string } | undefined)?.name ?? "anonymous";
}

/** A recording collection's membership and values. */
function listOf(collection: Recording): Iterable<readonly [unknown, unknown, boolean]> {
  return collection.list();
}
