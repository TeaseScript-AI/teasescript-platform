import { types } from "node:util";

/** A kind of object this comparator compares by its contents, as native clone carries it. */
type ContentKind = "date" | "regexp" | "view" | "buffer" | "map" | "set";

/** How `cloneKind` classifies an object: a content kind, an array, a record, or one it does not compare. */
type CloneKind = ContentKind | "array" | "record" | "unsupported";

/**
 * What native clone carries an object as, for each predicate of `node:util`'s `types` that is true for it: a kind this
 * comparator compares, or `unsupported`. `tests/bridge/player-engine-bridge-transport.test.ts` checks that it names every
 * predicate the running Node has; a predicate it does not name counts as `unsupported`.
 */
export const KIND_OF_TYPE: Readonly<Record<string, ContentKind | "unsupported">> = {
  isDate: "date",
  isRegExp: "regexp",
  isMap: "map",
  isSet: "set",
  isArrayBuffer: "buffer",
  isAnyArrayBuffer: "buffer",
  isArrayBufferView: "view",
  isDataView: "view",
  isTypedArray: "view",
  isUint8Array: "view",
  isUint8ClampedArray: "view",
  isUint16Array: "view",
  isUint32Array: "view",
  isInt8Array: "view",
  isInt16Array: "view",
  isInt32Array: "view",
  isFloat16Array: "view",
  isFloat32Array: "view",
  isFloat64Array: "view",
  isBigInt64Array: "view",
  isBigUint64Array: "view",
  isSharedArrayBuffer: "unsupported",
  isArgumentsObject: "unsupported",
  isAsyncFunction: "unsupported",
  isBigIntObject: "unsupported",
  isBooleanObject: "unsupported",
  isBoxedPrimitive: "unsupported",
  isExternal: "unsupported",
  isGeneratorFunction: "unsupported",
  isGeneratorObject: "unsupported",
  isMapIterator: "unsupported",
  isModuleNamespaceObject: "unsupported",
  isNativeError: "unsupported",
  isNumberObject: "unsupported",
  isPromise: "unsupported",
  isProxy: "unsupported",
  isSetIterator: "unsupported",
  isStringObject: "unsupported",
  isSymbolObject: "unsupported",
  isWeakMap: "unsupported",
  isWeakSet: "unsupported",
  isKeyObject: "unsupported",
  isCryptoKey: "unsupported",
};

/** A prototype whose own getters and methods read a built-in object's slots. */
type Owner = "TypedArray" | "DataView" | "ArrayBuffer" | "RegExp" | "Date" | "Map" | "Set";

const OWNERS = {
  // EVIDENCE: invariant: a typed array constructor's prototype inherits from `%TypedArray%.prototype`.
  TypedArray: Object.getPrototypeOf(Uint8Array.prototype) as object,
  DataView: DataView.prototype,
  ArrayBuffer: ArrayBuffer.prototype,
  RegExp: RegExp.prototype,
  Date: Date.prototype,
  Map: Map.prototype,
  Set: Set.prototype,
} as const;

/**
 * Every slot of a built-in object the comparator compares: its owner prototype and the key of the getter or method there
 * that reads it. Each is read through that getter or method (`intrinsic`), never as a property of the object, so an own
 * property cannot shadow it. `tests/bridge/player-engine-bridge-transport.test.ts` shadows each on both sides, and every other
 * own key of the admitted kinds' prototype chains but `constructor`.
 */
export const INTRINSIC_READS = {
  "typed array type": { owner: "TypedArray", key: Symbol.toStringTag },
  "typed array buffer": { owner: "TypedArray", key: "buffer" },
  "typed array offset": { owner: "TypedArray", key: "byteOffset" },
  "typed array length": { owner: "TypedArray", key: "byteLength" },
  "DataView buffer": { owner: "DataView", key: "buffer" },
  "DataView offset": { owner: "DataView", key: "byteOffset" },
  "DataView length": { owner: "DataView", key: "byteLength" },
  "buffer length": { owner: "ArrayBuffer", key: "byteLength" },
  "buffer resizable": { owner: "ArrayBuffer", key: "resizable" },
  "RegExp source": { owner: "RegExp", key: "source" },
  // `RegExp.prototype.flags` reads these as properties, so each flag is read through its own getter.
  "RegExp hasIndices": { owner: "RegExp", key: "hasIndices" },
  "RegExp global": { owner: "RegExp", key: "global" },
  "RegExp ignoreCase": { owner: "RegExp", key: "ignoreCase" },
  "RegExp multiline": { owner: "RegExp", key: "multiline" },
  "RegExp dotAll": { owner: "RegExp", key: "dotAll" },
  "RegExp unicode": { owner: "RegExp", key: "unicode" },
  "RegExp unicodeSets": { owner: "RegExp", key: "unicodeSets" },
  "RegExp sticky": { owner: "RegExp", key: "sticky" },
  "Date time": { owner: "Date", key: "getTime" },
  "Map entries": { owner: "Map", key: "entries" },
  "Set entries": { owner: "Set", key: "entries" },
} as const satisfies Readonly<
  Record<string, { readonly owner: Owner; readonly key: string | symbol }>
>;

/** The name of a slot the comparator reads. */
export type IntrinsicRead = keyof typeof INTRINSIC_READS;

/** A getter or method that reads a slot of the object it is called on. */
// oxlint-disable-next-line anti-slop/no-object-parameters, anti-slop/no-unknown-returns -- EVIDENCE: fixture: called on any built-in object of its kind; the typed readers below check what it returns.
type SlotReader = (this: object) => unknown;

/** Each read's getter or method, taken from its owner prototype once. */
const INTRINSICS = new Map<string, SlotReader>(
  Object.entries(INTRINSIC_READS).map(([name, { owner, key }]) => {
    const descriptor = Object.getOwnPropertyDescriptor(OWNERS[owner], key);
    const reader: unknown = descriptor?.get ?? descriptor?.value;
    if (typeof reader !== "function")
      throw new Error(`${owner} has no ${String(key)} to read ${name} with`);
    // EVIDENCE: invariant: a built-in prototype's own getter or method, called on an object of its kind, reads its slot.
    return [name, reader as SlotReader];
  }),
);

/** `value`'s slot `name`, read through its owner's own getter or method, which no own property of `value` shadows. */
// oxlint-disable-next-line anti-slop/no-object-parameters, anti-slop/no-unknown-returns -- EVIDENCE: fixture: a slot's value is checked by the typed readers below.
function intrinsic(name: IntrinsicRead, value: object): unknown {
  return INTRINSICS.get(name)!.call(value);
}

// oxlint-disable-next-line anti-slop/no-object-parameters -- EVIDENCE: fixture: reads a slot of an object `cloneKind` classified.
function intrinsicNumber(name: IntrinsicRead, value: object): number {
  const read = intrinsic(name, value);
  if (typeof read !== "number") throw new TypeError(`${name} read ${typeof read}`);
  return read;
}

// oxlint-disable-next-line anti-slop/no-object-parameters -- EVIDENCE: fixture: reads a slot of an object `cloneKind` classified.
function intrinsicObject(name: IntrinsicRead, value: object): object {
  const read = intrinsic(name, value);
  if (typeof read !== "object" || read === null) throw new TypeError(`${name} read ${typeof read}`);
  return read;
}

/** A regular expression's flags, in `RegExp.prototype.flags`'s order, each read through its getter. */
const FLAGS: readonly [IntrinsicRead, string][] = [
  ["RegExp hasIndices", "d"],
  ["RegExp global", "g"],
  ["RegExp ignoreCase", "i"],
  ["RegExp multiline", "m"],
  ["RegExp dotAll", "s"],
  ["RegExp unicode", "u"],
  ["RegExp unicodeSets", "v"],
  ["RegExp sticky", "y"],
];

// oxlint-disable-next-line anti-slop/no-object-parameters -- EVIDENCE: fixture: reads the slots of a regular expression `cloneKind` classified.
function regExpText(value: object): string {
  const flags = FLAGS.filter(([name]) => intrinsic(name, value) === true).map(([, flag]) => flag);
  const source = intrinsic("RegExp source", value);
  if (typeof source !== "string") throw new TypeError(`RegExp source read ${typeof source}`);
  return `/${source}/${flags.join("")}`;
}

/** A view's type, offset, length and buffer: a typed array's by its name, a `DataView`'s otherwise. */
// oxlint-disable-next-line anti-slop/no-object-parameters -- EVIDENCE: fixture: reads the slots of a view `cloneKind` classified.
function viewSlots(value: object): {
  readonly type: string;
  readonly offset: number;
  readonly length: number;
  readonly buffer: object;
} {
  const name = intrinsic("typed array type", value);
  if (typeof name === "string")
    return {
      type: name,
      offset: intrinsicNumber("typed array offset", value),
      length: intrinsicNumber("typed array length", value),
      buffer: intrinsicObject("typed array buffer", value),
    };
  return {
    type: "DataView",
    offset: intrinsicNumber("DataView offset", value),
    length: intrinsicNumber("DataView length", value),
    buffer: intrinsicObject("DataView buffer", value),
  };
}

/** A map's or set's entries, in order, read through its own `entries`. */
// oxlint-disable-next-line anti-slop/no-object-parameters -- EVIDENCE: fixture: reads the entries of a collection `cloneKind` classified.
function collectionEntries(name: "Map entries" | "Set entries", value: object): unknown[] {
  // EVIDENCE: invariant: `Map.prototype.entries` and `Set.prototype.entries` return an iterator of their entries.
  return [...(intrinsic(name, value) as Iterable<unknown>)];
}

/** The names `describe` gives each kind of object. */
const KIND_NAMES: Readonly<Record<Exclude<CloneKind, "view">, string>> = {
  date: "a Date",
  regexp: "a RegExp",
  buffer: "an ArrayBuffer",
  map: "a Map",
  set: "a Set",
  array: "an array",
  record: "an ordinary object",
  unsupported: "an object of a kind this does not compare",
};

/** A primitive as it reads in a difference: a string quoted, any other as `String` gives it. */
function primitiveText(
  value: string | number | bigint | boolean | symbol | undefined | null,
): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

/**
 * How a compared value reads in a difference: a primitive by `primitiveText`, a function or object by its kind alone
 * (`cloneKind`, a view by its intrinsic type), never coerced. The only place the comparator turns a compared value into
 * text. `tests/bridge/player-engine-bridge-transport.test.ts` checks statically that its body uses its `value` binding only in
 * these forms, and does not use `arguments`; that is not a data-flow proof (#1967).
 */
function describe(value: unknown, classes: readonly RecordClass[]): string {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean" ||
    typeof value === "symbol"
  )
    return primitiveText(value);
  if (typeof value !== "object") return "a function";
  const kind = cloneKind(value, classes);
  if (kind !== "view") return KIND_NAMES[kind];
  const type = intrinsic("typed array type", value);
  const name = typeof type === "string" ? type : "DataView";
  return `${/^[AEIOU]/u.test(name) ? "an" : "a"} ${name}`;
}

/** A class whose instances a test lists as records. */
export type RecordClass = abstract new (...args: never) => object;

export interface CloneGraphOptions {
  /**
   * The classes whose instances compare as records: by their own enumerable string keys, against a plain object in
   * `actual`, as native clone carries an ordinary class instance. Listing a class is the test's assertion that this is
   * how its instances cross; it proves nothing about the class's clone semantics, methods or private state. Every
   * class in an instance's prototype chain, up to `Object.prototype`, must be listed.
   */
  readonly classes?: readonly RecordClass[];
}

/**
 * How `actual`, a value that crossed a structured-clone port, differs from `expected` under structured-clone semantics,
 * or `null` when it does not. Iterative, so values of any depth compare: `assert.deepEqual` recurses and overflows.
 *
 * Kinds come from `util.types` (`cloneKind`), and both sides must be of one kind. The slots of a built-in object it
 * compares are read through intrinsic getters and methods (`INTRINSIC_READS`), and a difference describes a compared
 * value without coercing it (`describe`):
 * - a primitive compares with `Object.is`; a function, which native clone refuses, fails;
 * - a `Date` compares by its time value, a `RegExp` by its source and flags;
 * - a typed array or `DataView` compares by its type, offset and length, and its fixed-length `ArrayBuffer` as an object
 *   of the graph, which compares by its length and bytes, so two views over one buffer must cross over one buffer;
 * - a `Map` or `Set` compares by its entries in order;
 * - an array or a record compares by its length and own enumerable keys in order, so holes and non-index properties
 *   count. A record is an object with a null prototype, `Object.prototype` of any realm, or a chain of the classes
 *   `options.classes` lists; in `actual` it must be a plain object (native clone drops the prototype).
 *
 * The actual side's objects must have this realm's prototype of their kind. Shared objects and cycles compare as a
 * bijection. Any other object fails on either side, so a test meets it explicitly.
 */
export function cloneGraphDifference(
  actual: unknown,
  expected: unknown,
  options: CloneGraphOptions = {},
): string | null {
  const classes = options.classes ?? [];
  const forward = new Map<object, object>();
  const backward = new Map<object, object>();
  const pairs: {
    readonly actual: unknown;
    readonly expected: unknown;
    readonly path: Path | null;
  }[] = [{ actual, expected, path: null }];
  while (pairs.length > 0) {
    const pair = pairs.pop()!;
    const fail = (reason: string) => `${pathText(pair.path)}: ${reason}`;
    const a = pair.actual;
    const e = pair.expected;
    // A function is no primitive, and native clone refuses it, as `cloneKind` does.
    if (typeof a === "function" || typeof e === "function")
      return fail("a function, which native clone refuses");
    if (typeof e !== "object" || e === null || typeof a !== "object" || a === null) {
      if (!Object.is(a, e)) return fail(`${describe(a, classes)} is not ${describe(e, classes)}`);
      continue;
    }
    const known = forward.get(e);
    if (known !== undefined) {
      if (known !== a) return fail("a shared object crossed as two objects");
      continue;
    }
    if (backward.has(a)) return fail("two objects crossed as one");
    forward.set(e, a);
    backward.set(a, e);
    const kind = cloneKind(e, classes);
    if (kind === "unsupported") return fail("an expected object of a kind this does not compare");
    const actualKind = cloneKind(a, classes);
    if (actualKind !== kind)
      return fail(`${describe(a, classes)} where ${describe(e, classes)} was expected`);
    const push = (key: string, actualChild: unknown, expectedChild: unknown) =>
      pairs.push({
        actual: actualChild,
        expected: expectedChild,
        path: { parent: pair.path, key },
      });
    switch (kind) {
      case "date":
        if (Object.getPrototypeOf(a) !== Date.prototype) return fail("another leaf type");
        if (!Object.is(intrinsic("Date time", a), intrinsic("Date time", e)))
          return fail("another time");
        continue;
      case "regexp": {
        if (Object.getPrototypeOf(a) !== RegExp.prototype) return fail("another leaf type");
        if (regExpText(a) !== regExpText(e)) return fail("another pattern");
        continue;
      }
      case "view": {
        const [left, right] = [viewSlots(a), viewSlots(e)];
        if (left.type !== right.type || !ownPrototype(a, right.type))
          return fail("another view type");
        if (left.offset !== right.offset) return fail("another offset");
        if (left.length !== right.length) return fail("another length");
        push("buffer", left.buffer, right.buffer);
        continue;
      }
      case "buffer": {
        if (Object.getPrototypeOf(a) !== ArrayBuffer.prototype) return fail("another leaf type");
        if (intrinsicNumber("buffer length", a) !== intrinsicNumber("buffer length", e))
          return fail("another buffer length");
        // EVIDENCE: validation: `cloneKind` classified both as fixed-length `ArrayBuffer`s.
        const [left, right] = [new Uint8Array(a as ArrayBuffer), new Uint8Array(e as ArrayBuffer)];
        for (let index = 0; index < left.length; index += 1)
          if (left[index] !== right[index]) return fail(`another byte at ${index}`);
        continue;
      }
      case "map":
      case "set": {
        if (Object.getPrototypeOf(a) !== (kind === "map" ? Map.prototype : Set.prototype))
          return fail("another collection type");
        const entries = kind === "map" ? "Map entries" : "Set entries";
        const actualEntries = collectionEntries(entries, a);
        const expectedEntries = collectionEntries(entries, e);
        if (actualEntries.length !== expectedEntries.length) return fail("another collection size");
        for (let index = expectedEntries.length - 1; index >= 0; index -= 1)
          push(`entry ${index}`, actualEntries[index], expectedEntries[index]);
        continue;
      }
      case "array":
      case "record": {
        if (kind === "array") {
          if (Object.getPrototypeOf(a) !== Array.prototype) return fail("not this realm's array");
          // EVIDENCE: validation: `cloneKind` classified both as arrays.
          if ((a as unknown[]).length !== (e as unknown[]).length) return fail("another length");
        } else if (Object.getPrototypeOf(a) !== Object.prototype) return fail("not a plain object");
        const actualKeys = Object.keys(a);
        const expectedKeys = Object.keys(e);
        if (
          actualKeys.length !== expectedKeys.length ||
          expectedKeys.some((key, index) => actualKeys[index] !== key)
        )
          return fail(`keys ${JSON.stringify(actualKeys)} are not ${JSON.stringify(expectedKeys)}`);
        for (let index = expectedKeys.length - 1; index >= 0; index -= 1) {
          const key = expectedKeys[index]!;
          push(key, read(a, key), read(e, key));
        }
        continue;
      }
    }
  }
  return null;
}

/**
 * How native clone carries `value`, decided for both sides of a comparison. The kinds of `value`'s true `types`
 * predicates must be one content kind, and none `unsupported`: a shared buffer is also an `isAnyArrayBuffer`. A
 * resizable buffer is `unsupported`. An object no predicate names is an array, a record when its prototype chain is
 * proved ordinary (`isOrdinaryChain`), and otherwise `unsupported`.
 */
// oxlint-disable-next-line anti-slop/no-object-parameters -- EVIDENCE: fixture: classifies any object of a compared message, before its kind is known.
export function cloneKind(value: object, classes: readonly RecordClass[] = []): CloneKind {
  const kinds = new Set<ContentKind | "unsupported">();
  for (const [name, predicate] of Object.entries(types))
    if (predicate(value)) kinds.add(KIND_OF_TYPE[name] ?? "unsupported");
  if (kinds.has("unsupported") || kinds.size > 1) return "unsupported";
  const [kind] = kinds;
  if (kind === "buffer") {
    // (a shared buffer was refused above: it is also an `isSharedArrayBuffer`)
    return intrinsic("buffer resizable", value) === false ? "buffer" : "unsupported";
  }
  if (kind !== undefined) return kind;
  if (Array.isArray(value)) return "array";
  return isOrdinaryChain(value, classes) ? "record" : "unsupported";
}

/** Whether every prototype of `value`, up to `null` or `Object.prototype` of any realm, belongs to a class `classes` lists. */
// oxlint-disable-next-line anti-slop/no-object-parameters -- EVIDENCE: fixture: reads the prototype chain of any object of a compared message.
function isOrdinaryChain(value: object, classes: readonly RecordClass[]): boolean {
  for (
    let prototype: object | null = Object.getPrototypeOf(value);
    prototype !== null;
    prototype = Object.getPrototypeOf(prototype)
  ) {
    if (isObjectPrototype(prototype)) return true;
    if (!classes.some((listed) => listed.prototype === prototype)) return false;
  }
  return true;
}

const NATIVE_OBJECT_TEXT = Function.prototype.toString.call(Object);

/** Whether `prototype` is some realm's `Object.prototype`: it has no prototype, and its own `constructor` is native `Object`. */
// oxlint-disable-next-line anti-slop/no-object-parameters -- EVIDENCE: fixture: a prototype is any object of a chain being classified.
function isObjectPrototype(prototype: object): boolean {
  if (prototype === Object.prototype) return true;
  if (Object.getPrototypeOf(prototype) !== null) return false;
  const constructor: unknown = Object.getOwnPropertyDescriptor(prototype, "constructor")?.value;
  return (
    typeof constructor === "function" &&
    constructor.prototype === prototype &&
    Function.prototype.toString.call(constructor) === NATIVE_OBJECT_TEXT
  );
}

/** Whether `view`'s prototype is this realm's prototype of the view type `name` (`Uint8Array`, `DataView`). */
// oxlint-disable-next-line anti-slop/no-object-parameters -- EVIDENCE: fixture: checks the prototype of a view `cloneKind` classified.
function ownPrototype(view: object, name: string): boolean {
  const constructor: unknown = Object.getOwnPropertyDescriptor(globalThis, name)?.value;
  return typeof constructor === "function" && Object.getPrototypeOf(view) === constructor.prototype;
}

interface Path {
  readonly parent: Path | null;
  readonly key: string;
}

function pathText(path: Path | null): string {
  const keys: string[] = [];
  for (let at = path; at !== null; at = at.parent) keys.push(at.key);
  return keys.length === 0 ? "the root" : keys.reverse().join(".");
}

/** The value of an own enumerable key `key`, which `Object.keys` listed, of a crossed or expected object. */
// oxlint-disable-next-line anti-slop/no-object-parameters, anti-slop/no-unknown-returns -- EVIDENCE: fixture: compares arbitrary message objects, whose values stay untyped data.
function read(object: object, key: string): unknown {
  // EVIDENCE: invariant: `key` is one of `object`'s own enumerable keys, which `Object.keys` listed.
  return (object as Record<string, unknown>)[key];
}
