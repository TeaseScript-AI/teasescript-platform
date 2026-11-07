import { types } from "node:util";

/** A kind of object this comparator compares by its contents, as native clone carries it. */
type ContentKind = "date" | "regexp" | "view" | "buffer" | "map" | "set";

/** How `cloneKind` classifies an object: a content kind, an array, a record, or one it does not compare. */
type CloneKind = ContentKind | "array" | "record" | "unsupported";

/**
 * What native clone carries an object as, for each predicate of `node:util`'s `types` that is true for it: a kind this
 * comparator compares, or `unsupported`. `tests/player-engine-bridge-transport.test.ts` checks that it names every
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
 * Each object of either side is classified by `cloneKind`, and both sides must be of one kind:
 * - a primitive compares with `Object.is`;
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
    if (typeof e !== "object" || e === null || typeof a !== "object" || a === null) {
      if (!Object.is(a, e)) return fail(`${String(a)} is not ${String(e)}`);
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
    if (actualKind !== kind) return fail(`a ${actualKind} where a ${kind} was expected`);
    const push = (key: string, actualChild: unknown, expectedChild: unknown) =>
      pairs.push({
        actual: actualChild,
        expected: expectedChild,
        path: { parent: pair.path, key },
      });
    switch (kind) {
      case "date":
        if (Object.getPrototypeOf(a) !== Date.prototype) return fail("another leaf type");
        if (!Object.is(Date.prototype.getTime.call(a), Date.prototype.getTime.call(e)))
          return fail("another time");
        continue;
      case "regexp": {
        if (Object.getPrototypeOf(a) !== RegExp.prototype) return fail("another leaf type");
        // EVIDENCE: validation: `cloneKind` classified both as regular expressions.
        const [left, right] = [a as RegExp, e as RegExp];
        if (left.source !== right.source || left.flags !== right.flags)
          return fail("another pattern");
        continue;
      }
      case "view": {
        // EVIDENCE: validation: `cloneKind` classified both as views.
        const [left, right] = [a as ArrayBufferView, e as ArrayBufferView];
        const type = Object.prototype.toString.call(right);
        if (Object.prototype.toString.call(left) !== type || !ownPrototype(left, type))
          return fail("another view type");
        if (left.byteOffset !== right.byteOffset) return fail("another offset");
        if (left.byteLength !== right.byteLength) return fail("another length");
        push("buffer", left.buffer, right.buffer);
        continue;
      }
      case "buffer": {
        if (Object.getPrototypeOf(a) !== ArrayBuffer.prototype) return fail("another leaf type");
        // EVIDENCE: validation: `cloneKind` classified both as fixed-length `ArrayBuffer`s.
        const [left, right] = [new Uint8Array(a as ArrayBuffer), new Uint8Array(e as ArrayBuffer)];
        if (left.length !== right.length) return fail("another buffer length");
        for (let index = 0; index < left.length; index += 1)
          if (left[index] !== right[index]) return fail(`another byte at ${index}`);
        continue;
      }
      case "map":
      case "set": {
        if (Object.getPrototypeOf(a) !== (kind === "map" ? Map.prototype : Set.prototype))
          return fail("another collection type");
        // EVIDENCE: validation: `cloneKind` classified both as maps or both as sets.
        const actualEntries = [...(a as Map<unknown, unknown>).entries()];
        // EVIDENCE: validation: as above, for the expected side.
        const expectedEntries = [...(e as Map<unknown, unknown>).entries()];
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
    // (ES2024's `resizable`, which this project's ES2023 types do not declare, is `true` on a resizable buffer.)
    // EVIDENCE: validation: `isArrayBuffer` held, and a shared buffer was refused above.
    const buffer = value as { readonly resizable?: boolean };
    return buffer.resizable === true ? "unsupported" : "buffer";
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

/** Whether `view`'s prototype is this realm's prototype of the view type `type` names (`[object Uint8Array]`). */
function ownPrototype(view: ArrayBufferView, type: string): boolean {
  const name = type.slice("[object ".length, -1);
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
