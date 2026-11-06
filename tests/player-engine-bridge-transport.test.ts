import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import {
  BridgeLostError,
  BridgeRequestError,
  connectBridge,
  openBridge,
  type BridgeClient,
} from "../player/engine-bridge/client.js";
import { nodeWorkerPort } from "../player/engine-bridge/node-client.js";
import { BRIDGE_VERSION, type BuildIdentity } from "../player/engine-bridge/protocol.js";
import { decodeMessage, encodeMessage, NATIVE_NESTING } from "../player/engine-bridge/transport.js";
import { cloneGraphDifference } from "./helpers/clone-graph.js";

/*
 * The bridge's depth-safe transport (#1877): which path a message takes, that every path carries what native clone
 * carries, and that it refuses what native clone refuses, in this thread and through a real worker thread.
 */

const BUILD: BuildIdentity = { commit: null, dirty: null, mode: null, appVersion: null };
const FIXTURE_WORKER = new URL("./helpers/bridge-fixture-worker.js", import.meta.url);

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
    assert.equal(cloneGraphDifference(cross(message), expected), null, label);
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
    assert.equal(cloneGraphDifference(cross(message), message), null, label);
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
    { ...good, links: [1, "length", 0] },
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
