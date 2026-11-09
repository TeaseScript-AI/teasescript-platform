import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { types } from "node:util";
import vm from "node:vm";
import ts from "typescript";

import {
  BridgeLostError,
  BridgeRequestError,
  connectBridge,
  openBridge,
  type BridgeClient,
} from "../../player/engine-bridge/client.js";
import { nodeWorkerPort } from "../../player/engine-bridge/node-client.js";
import { BRIDGE_VERSION, type BuildIdentity } from "../../player/engine-bridge/protocol.js";
import { decodeMessage, encodeMessage, NATIVE_NESTING } from "../../player/engine-bridge/transport.js";
import {
  cloneGraphDifference,
  cloneKind,
  INTRINSIC_READS,
  KIND_OF_TYPE,
  type IntrinsicRead,
} from "../helpers/clone-graph.js";

/*
 * The bridge's depth-safe transport (#1877): which path a message takes, that every path carries what native clone
 * carries, and that it refuses what native clone refuses, in this thread and through a real worker thread.
 */

const BUILD: BuildIdentity = { commit: null, dirty: null, mode: null, appVersion: null };
const FIXTURE_WORKER = new URL("../helpers/bridge-fixture-worker.js", import.meta.url);

/** What a port does with a message: encode, clone, decode. */
// oxlint-disable-next-line anti-slop/no-unknown-returns -- EVIDENCE: fixture: builds or carries deliberately untyped message data for the transport under test.
const cross = (message: unknown): unknown => decodeMessage(structuredClone(encodeMessage(message)));

/** Container levels of `value` through own enumerable keys, iteratively, as the transport counts them. */
function height(value: unknown): number {
  let best = 0;
  const work: [unknown, number][] = [[value, 1]];
  const seen = new Set<object>();
  while (work.length > 0) {
    const [item, depth] = work.pop()!;
    if (typeof item !== "object" || item === null || seen.has(item)) continue;
    seen.add(item);
    best = Math.max(best, depth);
    for (const child of Object.values(item)) work.push([child, depth + 1]);
  }
  return best;
}

/** A chain of `levels` engine lists around `bottom`: two container levels per list. */
// oxlint-disable-next-line anti-slop/no-unknown-returns -- EVIDENCE: fixture: builds or carries deliberately untyped message data for the transport under test.
function lists(levels: number, bottom: unknown = 1): unknown {
  let value = bottom;
  for (let level = 0; level < levels; level += 1) value = { kind: "list", items: [value] };
  return value;
}

/** A chain of `levels` arrays around `bottom`: one container level each. */
// oxlint-disable-next-line anti-slop/no-unknown-returns -- EVIDENCE: fixture: builds or carries deliberately untyped message data for the transport under test.
function arrays(levels: number, bottom: unknown = 1): unknown {
  let value = bottom;
  for (let level = 0; level < levels; level += 1) value = [value];
  return value;
}

/** `levels` arrays, each holding the next one twice: a DAG whose tree would have 2^levels paths. */
// oxlint-disable-next-line anti-slop/no-unknown-returns -- EVIDENCE: fixture: builds or carries deliberately untyped message data for the transport under test.
function doubling(levels: number, bottom: unknown): unknown {
  let value = bottom;
  for (let level = 0; level < levels; level += 1) value = [value, value];
  return value;
}

/** Which path `message` takes: as it is, flattened from the sender's clone, or flattened after that clone overflowed. */
function pathOf(message: unknown): "as is" | "clone flattened" | "original flattened" {
  const native = globalThis.structuredClone;
  let overflowed = false;
  // EVIDENCE: fixture: a spy with native clone's signature, which forwards every call to it unchanged.
  globalThis.structuredClone = ((value: unknown) => {
    try {
      return native(value);
    } catch (error) {
      overflowed = true;
      throw error;
    }
  }) as typeof structuredClone;
  try {
    const encoded = encodeMessage(message);
    if (encoded === message) return "as is";
    assert.ok(height(encoded) <= 4, "a flat form nests at most four levels");
    return overflowed ? "original flattened" : "clone flattened";
  } finally {
    globalThis.structuredClone = native;
  }
}

/** Whether native clone carries `message` in this thread. */
function nativeCarries(message: unknown): boolean {
  try {
    structuredClone(message);
    return true;
  } catch {
    return false;
  }
}

class Entry {
  constructor(
    readonly key: string,
    readonly value: unknown,
  ) {}
}
class TaggedEntry extends Entry {}
Object.defineProperty(TaggedEntry.prototype, Symbol.toStringTag, { value: "StorageEntry" });
class TaggedMap extends Map<unknown, unknown> {}
// EVIDENCE: fixture: another realm's own `Object` constructor.
const ForeignObject = vm.runInNewContext("Object") as ObjectConstructor;
// EVIDENCE: fixture: another realm's class with `Entry`'s constructor and own fields.
const ForeignEntry = vm.runInNewContext(
  "(class Entry { constructor(key, value) { this.key = key; this.value = value; } })",
) as typeof Entry;
/** The fixture classes whose instances native clone carries as records. */
const RECORD_CLASSES = { classes: [Entry, TaggedEntry, ForeignEntry] };

/** Every kind of value the family puts under a chain: forms, keys, leaves and the kinds native clone copies as records. */
function variety() {
  const holes: unknown[] = [1];
  holes[2] = 3;
  holes.length = 5;
  const keyed: unknown[] & { extra?: unknown } = [1, 2];
  keyed.extra = { note: "a non-index property" };
  const proto: unknown = JSON.parse('{"__proto__":{"x":1},"y":2}');
  const foreign = Object.assign(new ForeignObject(), { plain: true });
  return {
    holes,
    keyed,
    proto,
    numbers: [undefined, -0, Number.NaN, 10n],
    leaves: [
      new Date(0),
      new Map([["a", { b: 1 }]]),
      /x+/giu,
      new Uint8Array([1, 2, 3]),
      new TaggedMap([[1, 2]]),
    ],
    entries: [
      new Entry("a", 1),
      new TaggedEntry("b", [2]),
      new ForeignEntry("c", { d: 3 }),
      foreign,
    ],
  };
}

test("a message crosses as it is up to the switch, and flat above it, from the sender's clone while that works", () => {
  for (const [label, message, path] of [
    ["one level", { a: 1 }, "as is"],
    ["at the switch", arrays(NATIVE_NESTING - 1, { a: 1 }), "as is"],
    ["above the switch", arrays(NATIVE_NESTING, { a: 1 }), "clone flattened"],
    ["1,000 levels", arrays(1_000, variety()), "clone flattened"],
    ["10,000 lists", lists(10_000, variety()), "original flattened"],
  ] as const) {
    assert.equal(height(message) <= NATIVE_NESTING, path === "as is", label);
    assert.equal(pathOf(message), path, label);
    const expected = nativeCarries(message) ? structuredClone(message) : message;
    assert.equal(cloneGraphDifference(cross(message), expected, RECORD_CLASSES), null, label);
  }
});

test("each kind a record can be is measured: class instances, tagged ones, other realms, Proxies, array properties", () => {
  const deep = lists(3_000);
  const keyed: unknown[] & { next?: unknown } = [];
  keyed.next = deep;
  for (const [label, entry] of [
    ["a plain entry", { key: "deep", value: deep }],
    ["a class instance", new Entry("deep", deep)],
    ["a tagged class instance", new TaggedEntry("deep", deep)],
    ["another realm's object", Object.assign(new ForeignObject(), { key: "deep", value: deep })],
    ["another realm's class instance", new ForeignEntry("deep", deep)],
    ["an array's non-index property", { key: "deep", value: keyed }],
  ] as const) {
    const message = {
      v: BRIDGE_VERSION,
      kind: "request",
      id: 1,
      session: null,
      basis: null,
      op: "start",
      args: [entry],
    };
    assert.equal(nativeCarries(message), false, `${label}: too deep for native clone`);
    assert.equal(pathOf(message), "original flattened", label);
    assert.equal(cloneGraphDifference(cross(message), message, RECORD_CLASSES), null, label);
  }
});

test("shared objects and cycles stay shared, at every path", () => {
  const tail = { end: true };
  const dag = doubling(60, tail);
  const cyclicRecord: { readonly name: string; self?: object } = { name: "loop" };
  cyclicRecord.self = cyclicRecord;
  const cyclicArray: unknown[] = [];
  cyclicArray.push(cyclicArray);
  const shared = { s: 1 };
  for (const [label, message] of [
    ["a DAG of 2^60 paths", { dag }],
    ["a cycle through a record", { cyclicRecord }],
    ["a cycle through an array", { cyclicArray }],
    ["a tail at two depths", { near: shared, far: arrays(300, shared) }],
    ["a tail at two depths, the other order", { far: arrays(300, shared), near: shared }],
    ["shared beyond the native limit", { a: lists(10_000, shared), b: shared }],
  ] as const) {
    assert.equal(
      cloneGraphDifference(
        cross(message),
        nativeCarries(message) ? structuredClone(message) : message,
      ),
      null,
      label,
    );
  }
  assert.equal(pathOf({ cyclicRecord }), "clone flattened", "a cycle is flattened");
});

/** Eight bytes, the same at offsets 0 and 3, so two views there differ only by their offset. */
const twinBytes = () => new Uint8Array([5, 6, 5, 5, 6, 5, 6, 5]).buffer;

test("the comparator tells apart what native clone keeps, and refuses every kind it does not compare", () => {
  // Each kind the comparator compares, by `cloneKind`'s name: a value, and one that differs from it.
  const kinds: [kind: string, label: string, value: object, other: object][] = [
    ["date", "a Date", new Date(0), new Date(1)],
    ["regexp", "a RegExp", /x+/gu, /x+/giu],
    ["view", "a typed array", new Uint16Array([1, 2]), new Uint16Array([1, 3])],
    ["view", "a DataView", new DataView(new ArrayBuffer(4)), new DataView(new ArrayBuffer(5))],
    ["buffer", "an ArrayBuffer", new Uint8Array([1, 2]).buffer, new Uint8Array([1, 3]).buffer],
    ["map", "a Map", new Map([["a", 1]]), new Map([["a", 2]])],
    ["set", "a Set", new Set([1]), new Set([2])],
    ["array", "an array", [1, 2], [1, 3]],
    ["record", "a record", { a: 1 }, { a: 2 }],
    [
      "record",
      "comma keys",
      { "a,b": undefined, c: undefined },
      { a: undefined, "b,c": undefined },
    ],
  ];
  // Objects the comparator does not compare, on either side.
  const unsupported: [label: string, value: object][] = [
    // (made by another realm's code: this project's ES2023 types have no resizable buffer)
    ["a resizable buffer", vm.runInNewContext("new ArrayBuffer(1, { maxByteLength: 2 })")],
    ["a shared buffer", new SharedArrayBuffer(1)],
    ["a boxed number", Object(1)],
    ["an Error", new Error("e")],
    ["a Blob", new Blob(["x"])],
    ["a File", new File(["x"], "x.txt")],
    ["an unlisted class", new (class Unlisted {})()],
  ];
  // Expected objects whose native clone compares equal: records of every admitted form, other realms' kinds.
  const admitted: [label: string, value: unknown][] = [
    ["a listed class", new Entry("a", 1)],
    ["a listed tagged class", new TaggedEntry("a", 1)],
    ["another realm's object", vm.runInNewContext("({ a: 1 })")],
    ["another realm's listed class", new ForeignEntry("a", 1)],
    ["a null prototype", Object.assign(Object.create(null), { a: 1 })],
    ["another realm's array", vm.runInNewContext("[1, 2]")],
    ["an Array subclass", Object.assign(new (class List extends Array {})(), [1, 2])],
    ["an array without a prototype", Object.setPrototypeOf([1], null)],
    ["another realm's Date", vm.runInNewContext("new Date(5)")],
    ["another realm's Map", vm.runInNewContext("new Map([[1, 2]])")],
    ["another realm's Set", vm.runInNewContext("new Set([1])")],
  ];
  const twin = () => {
    const [left, right] = [twinBytes(), twinBytes()];
    return [new Uint8Array(left, 3, 2), new Uint8Array(right, 0, 2)];
  };
  const shared = twinBytes();
  const split = { a: new Uint8Array(shared, 0, 4), b: new Uint8Array(shared, 4, 4) };
  const [one, two] = [twinBytes(), twinBytes()];
  const apart = { a: new Uint8Array(one, 0, 4), b: new Uint8Array(two, 4, 4) };
  const [atThree, atZero] = twin();
  // Other pairs that must differ.
  const functions = {
    "a function": () => 1,
    "an async function": async () => 1,
    "a generator": function* () {},
  };
  const differing: [label: string, actual: unknown, expected: unknown][] = [
    // Native clone refuses a function, so not even the same one compares equal (`cloneKind` calls it unsupported).
    ...Object.entries(functions).map(([label, value]): [string, unknown, unknown] => [
      `${label} against itself`,
      value,
      value,
    ]),
    ["a view at another offset over the same bytes", atZero, atThree],
    [
      "a view of another length",
      new Uint8Array(twinBytes(), 0, 3),
      new Uint8Array(twinBytes(), 0, 2),
    ],
    ["two views over one buffer, crossed over two", structuredClone(apart), split],
    ["two buffers, crossed as one", structuredClone(split), apart],
    // A fixed buffer must not stand for a shared one, though both are `isAnyArrayBuffer`.
    ["a fixed buffer for a shared one", new ArrayBuffer(8), new SharedArrayBuffer(8)],
    ["an ArrayBuffer for a record", new ArrayBuffer(1), {}],
    ["a record for an ArrayBuffer", {}, new ArrayBuffer(1)],
    ["another realm's array, not cloned", vm.runInNewContext("[1]"), [1]],
    ["an Array subclass, not cloned", Object.assign(new (class List extends Array {})(), [1]), [1]],
    ["an array without a prototype", Object.setPrototypeOf([1], null), [1]],
  ];

  const differs = (actual: unknown, expected: unknown) =>
    cloneGraphDifference(actual, expected, RECORD_CLASSES) !== null;
  for (const [kind, label, value, other] of kinds) {
    assert.equal(cloneKind(value, RECORD_CLASSES.classes), kind, label);
    assert.equal(differs(structuredClone(value), value), false, `${label}: its clone is equal`);
    assert.equal(differs(structuredClone(other), value), true, `${label}: another differs`);
  }
  for (const [label, value] of unsupported) {
    assert.equal(cloneKind(value, RECORD_CLASSES.classes), "unsupported", label);
    assert.equal(differs({}, value), true, `${label}, expected`);
    assert.equal(differs(value, {}), true, `${label}, actual`);
  }
  for (const [label, value] of admitted)
    assert.equal(differs(structuredClone(value), value), false, label);
  assert.equal(differs(structuredClone(split), split), false, "two views over one buffer");
  for (const [label, actual, expected] of differing)
    assert.equal(differs(actual, expected), true, label);

  // Every kind the comparator's own table and its object rule name has a case: the table is the obligation.
  const compared = new Set([...Object.values(KIND_OF_TYPE), "array", "record"]);
  compared.delete("unsupported");
  assert.deepEqual(new Set(kinds.map(([kind]) => kind)), compared);
  // The kind table names exactly the predicates this Node has, so a new kind of object cannot pass as a record.
  assert.deepEqual(Object.keys(KIND_OF_TYPE).sort(), Object.keys(types).sort());
});

/** Each read's expected value and one that differs from it in that slot alone, as source evaluated in either realm. */
const TWIN = "new Uint8Array([5, 6, 5, 5, 6, 5, 6, 5]).buffer";
const READ_FIXTURES: Record<IntrinsicRead, readonly [expected: string, differing: string]> = {
  "typed array type": ["new Uint16Array([1])", "new Uint8Array([1, 0])"],
  "typed array buffer": ["new Uint8Array([1])", "new Uint8Array([2])"],
  "typed array offset": [`new Uint8Array(${TWIN}, 3, 2)`, `new Uint8Array(${TWIN}, 0, 2)`],
  "typed array length": [`new Uint8Array(${TWIN}, 0, 2)`, `new Uint8Array(${TWIN}, 0, 3)`],
  "DataView buffer": [
    "new DataView(new Uint8Array([1]).buffer)",
    "new DataView(new Uint8Array([2]).buffer)",
  ],
  "DataView offset": [`new DataView(${TWIN}, 3, 2)`, `new DataView(${TWIN}, 0, 2)`],
  "DataView length": [`new DataView(${TWIN}, 0, 2)`, `new DataView(${TWIN}, 0, 3)`],
  "buffer length": ["new ArrayBuffer(1)", "new ArrayBuffer(2)"],
  "buffer resizable": ["new ArrayBuffer(1)", "new ArrayBuffer(1, { maxByteLength: 2 })"],
  "RegExp source": ["/x/g", "/y/g"],
  "RegExp hasIndices": ["/x/", "/x/d"],
  "RegExp global": ["/x/", "/x/g"],
  "RegExp ignoreCase": ["/x/", "/x/i"],
  "RegExp multiline": ["/x/", "/x/m"],
  "RegExp dotAll": ["/x/", "/x/s"],
  "RegExp unicode": ["/x/", "/x/u"],
  "RegExp unicodeSets": ["/x/", "/x/v"],
  "RegExp sticky": ["/x/", "/x/y"],
  "Date time": ["new Date(0)", "new Date(1)"],
  "Map entries": ["new Map([[1, 1]])", "new Map([[1, 2]])"],
  "Set entries": ["new Set([1])", "new Set([2])"],
};

/** Source that makes a sample of the kind `kind` with the global constructor `name`, in whichever realm runs it. */
function sampleSource(kind: string, name: string): string {
  if (name === "DataView") return "new DataView(new ArrayBuffer(2))";
  if (kind === "view" || kind === "buffer") return `new ${name}(2)`;
  if (kind === "date") return `new ${name}(3)`;
  if (kind === "regexp") return `new ${name}("x+", "gi")`;
  if (kind === "map") return `new ${name}([[1, { a: 2 }]])`;
  if (kind === "set") return `new ${name}([1, 2])`;
  if (kind === "array") return `${name}.of(1, { a: 2 })`;
  return `Object.assign(new ${name}(), { a: 1, b: [2] })`;
}

const REALMS = {
  "this realm": (source: string): object => vm.runInThisContext(source),
  "another realm": (source: string): object => vm.runInNewContext(source),
};

/** The prototypes `INTRINSIC_READS` names as owners, found from this realm's constructors. */
const OWNER_PROTOTYPES = {
  TypedArray: Object.getPrototypeOf(Uint8Array.prototype),
  DataView: DataView.prototype,
  ArrayBuffer: ArrayBuffer.prototype,
  RegExp: RegExp.prototype,
  Date: Date.prototype,
  Map: Map.prototype,
  Set: Set.prototype,
} as const;

/** `key` as this realm's getter or method of `owner` reads it on `value`: a value, or for a method its result. */
// oxlint-disable-next-line anti-slop/no-object-parameters, anti-slop/no-unknown-returns -- EVIDENCE: fixture: reads any slot of a fixture object, whatever its kind.
function readThrough(owner: object, key: string | symbol, value: object): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(owner, key)!;
  return (descriptor.get ?? descriptor.value).call(value);
}

/** Gives `value` an own property `key` that claims `claim`: as a value, or for a method a method that returns it. */
// oxlint-disable-next-line anti-slop/no-object-parameters -- EVIDENCE: fixture: shadows a slot of any fixture object, whatever its kind.
function shadow(value: object, owner: object, key: string | symbol, claim: unknown): void {
  const method = typeof Object.getOwnPropertyDescriptor(owner, key)!.value === "function";
  Object.defineProperty(value, key, { value: method ? () => claim : claim, configurable: true });
}

test("no own property of a built-in object's prototype surface, `constructor` aside, changes how the comparator compares it, in either realm", () => {
  const verdict = (actual: unknown, expected: unknown) => {
    try {
      return cloneGraphDifference(actual, expected, RECORD_CLASSES) === null ? "equal" : "differs";
    } catch (error) {
      return `threw ${String(error)}`;
    }
  };
  const generated = new Set<string>();

  // Each slot the comparator reads: a shadow that claims the other value's slot keeps the verdict, on either side.
  assert.deepEqual(Object.keys(READ_FIXTURES).sort(), Object.keys(INTRINSIC_READS).sort());
  for (const [read, [expectedSource, differingSource]] of Object.entries(READ_FIXTURES))
    for (const [realm, make] of Object.entries(REALMS))
      for (const position of ["expected", "actual"])
        for (const outcome of ["equal", "differs"]) {
          const name = `${read} × ${position} × ${outcome} × ${realm}`;
          // EVIDENCE: validation: the fixtures' keys were just checked to be `INTRINSIC_READS`'s.
          const { owner, key } = INTRINSIC_READS[read as IntrinsicRead];
          const prototype: object = OWNER_PROTOTYPES[owner];
          const expected = make(expectedSource);
          const differing = make(differingSource);
          const actual: object = structuredClone(outcome === "equal" ? expected : differing);
          const lied = position === "actual" ? actual : expected;
          // The claim makes equal values look different, and different values look equal.
          const claimFrom =
            outcome === "equal" ? differing : position === "actual" ? expected : differing;
          const slot = readThrough(prototype, key, claimFrom);
          // (a collection's entries are claimed as an array, which spreads as its iterator would)
          // EVIDENCE: invariant: `entries` returns an iterator of the collection's entries.
          const claim = key === "entries" ? [...(slot as Iterable<unknown>)] : slot;
          shadow(lied, prototype, key, claim);
          assert.equal(verdict(actual, expected), outcome, name);
          generated.add(name);
        }

  // The surfaces: each `types` predicate of this Node that the kind table admits names its global constructor
  // (`isUint8Array`, `Uint8Array`), whose prototype chain is walked through `Object.prototype`; an array's and a
  // record's are `Array`'s and `Object`'s. A predicate with no global constructor must hold for a walked sample.
  const admitted = new Set([...Object.values(KIND_OF_TYPE), "array", "record"]);
  admitted.delete("unsupported");
  const constructors = new Map<string, string>([
    ["Array", "array"],
    ["Object", "record"],
  ]);
  const umbrellas: string[] = [];
  for (const predicate of Object.keys(types)) {
    const kind = KIND_OF_TYPE[predicate] ?? "unsupported";
    if (kind === "unsupported") continue;
    const name = predicate.slice("is".length);
    if (typeof Object.getOwnPropertyDescriptor(globalThis, name)?.value === "function")
      constructors.set(name, kind);
    else umbrellas.push(predicate);
  }
  assert.deepEqual(new Set(constructors.values()), admitted, "every admitted kind has a surface");
  const samples = [...constructors].map(([name, kind]) =>
    REALMS["this realm"](sampleSource(kind, name)),
  );
  const predicates = new Map(Object.entries(types));
  for (const predicate of umbrellas)
    assert.ok(
      samples.some((sample) => predicates.get(predicate)!(sample)),
      `${predicate} holds for a walked sample`,
    );

  // Each own key of each surface, on each side, in both realms. `constructor` is outside the axis by design (#1967). A key the comparator reads must
  // have run all its cases above. Any other key gets an accessor that throws when read: the comparator never reads it,
  // so a sample still equals its clone, and against a primitive it still differs, without throwing.
  const readNames = new Map(
    Object.entries(INTRINSIC_READS).map(([name, { owner, key }]) => [
      `${owner} ${String(key)}`,
      name,
    ]),
  );
  const pending = new Set<string>();
  const executed = new Set<string>();
  const unshadowable = new Set<string>();
  const readsOnSurface = new Set<string>();
  for (const [name, kind] of constructors)
    for (
      let prototype: object | null = Object.getPrototypeOf(
        REALMS["this realm"](sampleSource(kind, name)),
      );
      prototype !== null;
      prototype = Object.getPrototypeOf(prototype)
    ) {
      const owner = Object.entries(OWNER_PROTOTYPES).find(([, value]) => value === prototype)?.[0];
      for (const key of Reflect.ownKeys(prototype)) {
        if (key === "constructor") continue;
        const read = owner === undefined ? undefined : readNames.get(`${owner} ${String(key)}`);
        for (const [realm, make] of Object.entries(REALMS))
          for (const position of ["expected", "actual"]) {
            const cell = `${name} ${String(key)} × ${position} × ${realm}`;
            // Two pieces of evidence per cell: the slot's comparison, and the comparison with a primitive, whose
            // difference is described.
            for (const evidence of ["slot", "primitive"]) pending.add(`${cell} × ${evidence}`);
            if (read !== undefined) {
              // A slot the comparator reads: its claiming shadows ran above, in this position and realm.
              readsOnSurface.add(read);
              for (const outcome of ["equal", "differs"])
                assert.ok(generated.has(`${read} × ${position} × ${outcome} × ${realm}`), cell);
              executed.add(`${cell} × slot`);
            }
            // Any key, a read one too, shadowed by an accessor that throws when read: compared with its clone (for a
            // key that is no read) it stays equal, and compared with a primitive it still differs, without throwing.
            for (const evidence of read === undefined ? ["slot", "primitive"] : ["primitive"]) {
              const sample = make(sampleSource(kind, name));
              const clone: object = structuredClone(sample);
              // The shadowed object is the sample on the expected side, or its clone on the actual side.
              const lied = position === "expected" ? sample : clone;
              const expected = evidence === "primitive" && position === "actual" ? 0 : sample;
              const actual = evidence === "primitive" ? (position === "actual" ? clone : 0) : clone;
              const descriptor = Object.getOwnPropertyDescriptor(lied, key);
              if (descriptor !== undefined && !descriptor.configurable) {
                // An own slot of the instance, such as an array's `length`: no property can shadow it.
                unshadowable.add(`${cell} × ${evidence}`);
                continue;
              }
              Object.defineProperty(lied, key, {
                get: () => {
                  throw new Error(`read ${String(key)}`);
                },
                configurable: true,
              });
              const outcome = evidence === "primitive" ? "differs" : "equal";
              assert.equal(verdict(actual, expected), outcome, `${cell} × ${evidence}`);
              executed.add(`${cell} × ${evidence}`);
            }
          }
      }
    }
  // Every enumerated key, on each side and in each realm, has both pieces of evidence, or is an own slot no property
  // can shadow.
  for (const surface of pending)
    assert.ok(executed.has(surface) || unshadowable.has(surface), surface);
  assert.deepEqual(
    [...unshadowable].map((surface) => surface.split(" × ")[0]),
    [...unshadowable].map(() => "Array length"),
    "only an array's length cannot be shadowed",
  );
  // And every slot the comparator reads lies on an admitted kind's surface.
  assert.deepEqual(readsOnSurface, new Set(Object.keys(INTRINSIC_READS)));
});

test("the comparator's diagnostic uses its `value` binding only by type, kind and intrinsic view type, and no `arguments`", () => {
  const path = resolve(process.cwd(), "tests/helpers/clone-graph.ts");
  const source = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const functions = new Map<string, ts.FunctionDeclaration>();
  for (const statement of source.statements)
    if (ts.isFunctionDeclaration(statement) && statement.name)
      functions.set(statement.name.text, statement);
  const describe = functions.get("describe")!;
  const parameter = describe.parameters[0]!.name.getText(source);
  // Each use of the `value` binding is one of these forms, and the body does not use `arguments`. This is a check of
  // the binding's uses, not of data flow: an indirect read through another binding is outside it (#1967).
  const uses: string[] = [];
  const allowed = (node: ts.Identifier): boolean => {
    const parent = node.parent;
    if (ts.isParameter(parent)) return true;
    if (ts.isTypeOfExpression(parent)) return true;
    if (
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
      [parent.left, parent.right].some(
        (side) => side.kind === ts.SyntaxKind.NullKeyword || side.getText(source) === "undefined",
      )
    )
      return true;
    if (!ts.isCallExpression(parent) || !ts.isIdentifier(parent.expression)) return false;
    const callee = parent.expression.text;
    if (callee === "primitiveText" || callee === "cloneKind") return parent.arguments[0] === node;
    return (
      callee === "intrinsic" &&
      parent.arguments[1] === node &&
      parent.arguments[0]?.getText(source) === '"typed array type"'
    );
  };
  const visit = (node: ts.Node): void => {
    assert.ok(!(ts.isIdentifier(node) && node.text === "arguments"), "describe uses `arguments`");
    if (ts.isIdentifier(node) && node.text === parameter) {
      uses.push(node.parent.getText(source));
      assert.ok(allowed(node), `describe uses its argument in \`${node.parent.getText(source)}\``);
    }
    ts.forEachChild(node, visit);
  };
  visit(describe);
  assert.ok(uses.length > 1, "describe's argument was found");
  // `primitiveText` takes primitives only, so tsc refuses an object passed to it.
  const primitive = functions.get("primitiveText")!.parameters[0]!.type!.getText(source);
  assert.doesNotMatch(primitive, /\b(?:unknown|object|any)\b|[{[]/u, primitive);
});

test("what native clone refuses is refused at every depth it can read, also inside a Proxy", () => {
  const { proxy: revoked, revoke } = Proxy.revocable({}, {});
  revoke();
  const refused: [string, unknown][] = [
    ["a function", () => 1],
    ["a symbol", Symbol("s")],
    ["a Promise", Promise.resolve(1)],
    ["a WeakMap", new WeakMap()],
    ["a Proxy", new Proxy({ a: 1 }, {})],
    ["a revoked Proxy", revoked],
  ];
  for (const [label, value] of refused)
    for (const levels of [1, NATIVE_NESTING + 1, 1_000]) {
      const message = { args: arrays(levels, [value]) };
      const native = errorName(() => structuredClone(message));
      assert.equal(native, "DataCloneError", `${label} at ${levels}: native clone refuses it`);
      assert.equal(
        errorName(() => cross(message)),
        native,
        `${label} at ${levels}`,
      );
    }
  // Beyond the sender's native limit only the codec reads the message; a function or symbol is still refused there.
  for (const value of [() => 1, Symbol("s")])
    assert.equal(
      errorName(() => cross({ args: lists(10_000, [value]) })),
      "DataCloneError",
    );
});

function errorName(run: () => void): string | null {
  try {
    run();
    return null;
  } catch (error) {
    return error instanceof Error ? error.name : String(error);
  }
}

test("a flat form is decoded only when it is whole; anything else passes as it came", () => {
  const good = { v: BRIDGE_VERSION, kind: "nested", nodes: [{ a: 0 }, [1]], links: [0, "a", 1] };
  assert.deepEqual(decodeMessage(structuredClone(good)), { a: [1] });
  for (const bad of [
    { ...good, links: [0, "a", 1, 1, "length", 0] },
    { ...good, links: [0, "a", 2] },
    { ...good, links: [0, "b", 1] },
    { ...good, links: [0, "a"] },
    { ...good, nodes: [] },
    { ...good, v: BRIDGE_VERSION + 1 },
    { ...good, extra: 1 },
    { v: BRIDGE_VERSION, kind: "nested", nodes: [{ a: 7 }, [1]], links: [0, "a", 1] },
  ]) {
    const data = structuredClone(bad);
    const before = JSON.stringify(data);
    assert.equal(decodeMessage(data), data);
    assert.equal(JSON.stringify(data), before, "nothing was linked");
  }
});

async function withClient<T>(body: (client: BridgeClient) => Promise<T>): Promise<T> {
  const client = await connectBridge(nodeWorkerPort(FIXTURE_WORKER, BUILD), BUILD);
  try {
    return await body(client);
  } finally {
    client.terminate();
  }
}

test("through a worker thread, deep values cross both ways, and a deep refusal is answered as before", async () => {
  await withClient(async (client) => {
    for (const message of [variety(), arrays(1_000, variety()), lists(10_000, variety())]) {
      const reply = await client.request("echo", message);
      assert.equal(
        cloneGraphDifference(
          reply.result,
          nativeCarries(message) ? structuredClone(message) : message,
          RECORD_CLASSES,
        ),
        null,
      );
    }
    // A request that cannot cross rejects without effect, and the next one is answered.
    const request = await client
      .request(
        "echo",
        lists(1_000, () => 1),
      )
      .catch((error: unknown) => error);
    assert.ok(request instanceof Error && request.name === "DataCloneError");
    assert.equal((await client.request("echo", 1)).result, 1);
    // A result that cannot cross is an engine error reply.
    for (const levels of [1, 1_000, 10_000]) {
      const reply = await client.request("deepClone", levels).catch((error: unknown) => error);
      assert.ok(reply instanceof BridgeRequestError, `${levels}`);
      assert.deepEqual([reply.name, reply.kind], ["DataCloneError", "engine"]);
    }
  });
});

test("a client loses its Worker on a malformed flat form, as on any message it cannot read", async () => {
  let deliver: (data: unknown) => void = () => {};
  const { client, ready } = openBridge(
    {
      post: () => {},
      listen: (listener) => void (deliver = listener),
      onFailure: () => {},
      terminate: () => {},
    },
    BUILD,
  );
  deliver({ v: BRIDGE_VERSION, kind: "ready", build: BUILD });
  await ready;
  const lost = new Promise<BridgeLostError>((resolve) => client.onLoss(resolve));
  deliver({ v: BRIDGE_VERSION, kind: "nested", nodes: [{ a: 0 }], links: [0, "a", 3] });
  assert.ok((await lost) instanceof BridgeLostError);
});
