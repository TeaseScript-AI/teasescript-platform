import assert from "node:assert/strict";
import test from "node:test";

import { createLocalScriptStorage } from "../player/script-storage.js";
import { serializeValidatedRuntimeJson } from "../src/runtime/checkpoint.js";
import type { SerializableRuntimeValue } from "../src/index.js";

class MemoryStorage implements Storage {
  private readonly items = new Map<string, string>();

  get length(): number {
    return this.items.size;
  }

  clear(): void {
    this.items.clear();
  }

  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.items.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.items.delete(key);
  }

  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
}

function itemName(scope: string, key: string): string {
  return "player-storage:" + JSON.stringify([scope, key]);
}

const headName = (scope: string) => "player-storage-head:" + JSON.stringify(scope);

/** The published generation of a scope, read as the test's own oracle of the documented layout. */
function generationOf(storage: Storage, scope: string): string {
  const head: unknown = JSON.parse(storage.getItem(headName(scope)) ?? "null");
  assert.ok(head !== null && typeof head === "object" && "generation" in head);
  const { generation } = head;
  assert.ok(typeof generation === "string");
  return generation;
}

function generationItemName(scope: string, generation: string, key: string): string {
  return "player-storage-generation:" + JSON.stringify([scope, generation, key]);
}

/** Storage whose writes fail from a chosen write on, like a browser that runs out of quota. */
class QuotaStorage extends MemoryStorage {
  writesBeforeFailure = Infinity;

  override setItem(key: string, value: string): void {
    if (this.writesBeforeFailure <= 0) throw new Error("Quota exceeded");
    this.writesBeforeFailure -= 1;
    super.setItem(key, value);
  }
}

const asMap = (entries: readonly { key: string; value: SerializableRuntimeValue }[]) =>
  new Map(entries.map(({ key, value }) => [key, value]));

test("local script storage round trips every stored value type and lossless string keys", async () => {
  const storage = new MemoryStorage();
  const scope = 'script:"/\udfff';
  const provider = createLocalScriptStorage(storage, scope);
  assert.equal(provider.scope, scope);
  const entries: { key: string; value: SerializableRuntimeValue }[] = [
    { key: "media", value: "images/room.svg" },
    { key: "number", value: 2.5 },
    { key: "boolean", value: false },
    { key: "list", value: { kind: "list", items: [1, null, "two"] } },
    {
      key: "object",
      value: {
        kind: "object",
        properties: [{ name: "nested", value: { kind: "list", items: [true, null] } }],
      },
    },
    { key: "set", value: { kind: "set", items: ["a", "b"] } },
    { key: "range", value: { kind: "range", start: 2, end: 5, inclusive: true } },
    { key: "duration", value: { kind: "duration", milliseconds: 1_500 } },
    { key: "lone-\ud800-surrogate", value: "kept" },
  ];
  for (const { key, value } of entries) {
    await provider.write(key, value);
    assert.equal(storage.getItem(itemName(scope, key)), JSON.stringify({ v: 1, value }), key);
  }
  const loaded = await createLocalScriptStorage(storage, scope).load();
  assert.deepEqual(
    new Map(loaded.map(({ key, value }) => [key, value])),
    new Map(entries.map(({ key, value }) => [key, value])),
  );
});

test("local script storage isolates loads and clears to its bound scope", async () => {
  const storage = new MemoryStorage();
  storage.setItem("player-settings", "keep preferences");
  const provider = createLocalScriptStorage(storage, "first");
  const second = createLocalScriptStorage(storage, "second");
  await provider.write("same", 1);
  await provider.write("other", 2);
  await second.write("same", 3);
  const first = await provider.load();
  assert.deepEqual(
    new Map(first.map(({ key, value }) => [key, value])),
    new Map([
      ["other", 2],
      ["same", 1],
    ]),
  );
  assert.deepEqual(await second.load(), [{ key: "same", value: 3 }]);
  assert.deepEqual(await createLocalScriptStorage(storage, "missing").load(), []);

  await provider.clear();
  assert.equal(storage.getItem(itemName("first", "same")), null);
  assert.equal(storage.getItem(itemName("first", "other")), null);
  assert.deepEqual(await provider.load(), []);
  assert.deepEqual(await second.load(), [{ key: "same", value: 3 }]);
  assert.equal(storage.getItem(itemName("second", "same")), JSON.stringify({ v: 1, value: 3 }));
  assert.equal(storage.getItem("player-settings"), "keep preferences");
  // Besides the other scope's value and the preference, only the cleared scope's empty head remains.
  assert.equal(storage.length, 3);
  assert.equal(typeof generationOf(storage, "first"), "string");
});

test("local script storage skips invalid payloads and foreign items without losing valid entries", async () => {
  const storage = new MemoryStorage();
  storage.setItem(itemName("demo", "valid"), JSON.stringify({ v: 1, value: "kept" }));
  const invalidPayloads = [
    "{",
    "null",
    "[]",
    JSON.stringify({ value: "missing version" }),
    JSON.stringify({ v: 2, value: "wrong version" }),
    JSON.stringify({ v: 1 }),
    JSON.stringify({ v: 1, value: null }),
    JSON.stringify({ v: 1, value: { unexpected: "plain object" } }),
    JSON.stringify({ v: 1, value: { kind: "duration", milliseconds: "not a number" } }),
    JSON.stringify({ v: 1, value: { kind: "list", items: [{ kind: "timerHandle", timerId: 1 }] } }),
  ];
  invalidPayloads.forEach((payload, index) => {
    storage.setItem(itemName("demo", `invalid-${index}`), payload);
  });
  for (const name of [
    "unrelated",
    "player-storage:not-json",
    'player-storage:["demo"]',
    'player-storage:["demo",42]',
    'player-storage:["demo","extra","part"]',
    itemName("another-script", "foreign"),
  ]) {
    storage.setItem(name, JSON.stringify({ v: 1, value: "foreign" }));
  }
  const countBeforeLoad = storage.length;
  assert.deepEqual(await createLocalScriptStorage(storage, "demo").load(), [
    { key: "valid", value: "kept" },
  ]);
  assert.equal(storage.length, countBeforeLoad, "loading does not remove skipped items");
});

test("local script storage removes an item when a write receives null", async () => {
  const storage = new MemoryStorage();
  const provider = createLocalScriptStorage(storage, "demo");
  await provider.write("answer", 42);
  assert.deepEqual(await provider.load(), [{ key: "answer", value: 42 }]);
  await provider.write("answer", null);
  assert.equal(storage.getItem(itemName("demo", "answer")), null);
  assert.deepEqual(await provider.load(), []);
  await provider.write("missing", null);
  assert.equal(storage.length, 0);
});

test("local script storage rejects a failed write without replacing the previous value", async () => {
  const storage = new QuotaStorage();
  storage.setItem(itemName("demo", "answer"), '{"v":1,"value":41}');
  storage.writesBeforeFailure = 0;
  const provider = createLocalScriptStorage(storage, "demo");
  await assert.rejects(provider.write("answer", 42), /Quota exceeded/);
  assert.deepEqual(await provider.load(), [{ key: "answer", value: 41 }]);
});

test("local script storage rejects every operation when storage is missing or throws", async () => {
  const denied: Storage = {
    get length(): never {
      throw new Error("Storage denied");
    },
    get key(): never {
      throw new Error("Storage denied");
    },
    get getItem(): never {
      throw new Error("Storage denied");
    },
    get setItem(): never {
      throw new Error("Storage denied");
    },
    get removeItem(): never {
      throw new Error("Storage denied");
    },
    get clear(): never {
      throw new Error("Storage denied");
    },
  };
  for (const storage of [undefined, denied]) {
    const provider = createLocalScriptStorage(storage, "demo");
    await assert.rejects(provider.load());
    await assert.rejects(provider.write("answer", 42));
    await assert.rejects(provider.write("answer", null));
    await assert.rejects(provider.replace([{ key: "answer", value: 42 }]));
    await assert.rejects(provider.clear());
  }
});

test("local script storage ignores item-name aliases of a key", async () => {
  const storage = new MemoryStorage();
  const alias = 'player-storage:[ "demo", "answer" ]';
  storage.setItem(alias, JSON.stringify({ v: 1, value: "alias" }));
  const provider = createLocalScriptStorage(storage, "demo");
  // An alias alone is not an entry, so removing the key cannot leave it to resurface after a reload.
  assert.deepEqual(await provider.load(), []);

  await provider.write("answer", "kept");
  // With the canonical item present too, the key appears once, so a session can start from it.
  assert.deepEqual(await provider.load(), [{ key: "answer", value: "kept" }]);
  await provider.write("answer", null);
  assert.deepEqual(await provider.load(), []);
});

test("a replacement publishes all of its values at once and removes the values it displaced", async () => {
  const storage = new MemoryStorage();
  const provider = createLocalScriptStorage(storage, "demo");
  // Values saved before the first replacement use the original layout and still load.
  await provider.write("old", 1);
  await provider.write("kept", "before");
  const replacement = [
    { key: "kept", value: "after" },
    { key: "new", value: { kind: "list", items: [1, "two"] } },
    { key: "", value: true },
  ] satisfies { key: string; value: SerializableRuntimeValue }[];
  await provider.replace(replacement);
  assert.deepEqual(asMap(await provider.load()), asMap(replacement));
  // A fresh provider, as after a reload, reads the same values.
  assert.deepEqual(
    asMap(await createLocalScriptStorage(storage, "demo").load()),
    asMap(replacement),
  );
  const first = generationOf(storage, "demo");
  assert.equal(storage.getItem(itemName("demo", "old")), null, "displaced values are removed");
  assert.equal(storage.getItem(itemName("demo", "kept")), null);
  assert.equal(
    storage.getItem(generationItemName("demo", first, "new")),
    JSON.stringify({ v: 1, value: replacement[1]!.value }),
  );
  assert.equal(storage.length, replacement.length + 1);

  // Later saves and deletes change the published generation, key by key.
  await provider.write("kept", "saved later");
  await provider.write("new", null);
  assert.deepEqual(
    asMap(await provider.load()),
    new Map<string, SerializableRuntimeValue>([
      ["kept", "saved later"],
      ["", true],
    ]),
  );

  // A second replacement displaces the first generation.
  await provider.replace([{ key: "only", value: 3 }]);
  assert.notEqual(generationOf(storage, "demo"), first);
  assert.deepEqual(await provider.load(), [{ key: "only", value: 3 }]);
  assert.equal(storage.length, 2);

  // An empty replacement clears, and the scope stays cleared after a reload.
  await provider.replace([]);
  assert.deepEqual(await createLocalScriptStorage(storage, "demo").load(), []);
  assert.equal(storage.length, 1);
});

test("a replacement that cannot be staged or published keeps every previous value", async () => {
  // Fail on each write of a two-value replacement in turn: both staged values, then the head that publishes them.
  for (const failingWrite of [0, 1, 2]) {
    for (const published of [false, true]) {
      const storage = new QuotaStorage();
      const provider = createLocalScriptStorage(storage, "demo");
      if (published) await provider.replace([{ key: "answer", value: 41 }]);
      else await provider.write("answer", 41);
      const before = new Map(
        Array.from({ length: storage.length }, (_, index) => {
          const name = storage.key(index)!;
          return [name, storage.getItem(name)];
        }),
      );
      storage.writesBeforeFailure = failingWrite;
      await assert.rejects(
        provider.replace([
          { key: "answer", value: 42 },
          { key: "extra", value: "new" },
        ]),
        /Quota exceeded/,
      );
      const after = new Map(
        Array.from({ length: storage.length }, (_, index) => {
          const name = storage.key(index)!;
          return [name, storage.getItem(name)];
        }),
      );
      assert.deepEqual(after, before, `write ${failingWrite}: nothing staged remains`);
      storage.writesBeforeFailure = Infinity;
      assert.deepEqual(await provider.load(), [{ key: "answer", value: 41 }]);
    }
  }
});

test("a replacement with values that are not script storage changes nothing", async () => {
  const storage = new MemoryStorage();
  const provider = createLocalScriptStorage(storage, "demo");
  await provider.write("answer", 41);
  const invalid: { key: string; value: SerializableRuntimeValue }[][] = [
    [{ key: "answer", value: null }],
    [
      { key: "same", value: 1 },
      { key: "same", value: 2 },
    ],
    [{ key: "handle", value: { kind: "timerHandle", timerId: 1 } }],
    [{ key: "number", value: Number.NaN }],
  ];
  for (const entries of invalid) {
    await assert.rejects(provider.replace(entries), TypeError);
  }
  assert.equal(storage.length, 1);
  assert.deepEqual(await provider.load(), [{ key: "answer", value: 41 }]);
});

test("only the published generation is a scope's values; an unreadable head never reveals older values", async () => {
  const storage = new MemoryStorage();
  const provider = createLocalScriptStorage(storage, "demo");
  const other = createLocalScriptStorage(storage, "demo-other");
  await other.write("answer", "other scope");
  await provider.write("answer", "legacy");
  await provider.replace([{ key: "answer", value: "published" }]);
  // Items of another generation, such as a late write of another tab into a displaced one, stay invisible.
  storage.setItem(
    generationItemName("demo", "0".repeat(32), "stray"),
    JSON.stringify({ v: 1, value: "stray" }),
  );
  assert.deepEqual(await provider.load(), [{ key: "answer", value: "published" }]);
  assert.deepEqual(await other.load(), [{ key: "answer", value: "other scope" }]);

  for (const head of [
    "{",
    JSON.stringify({ v: 2, generation: "0".repeat(32) }),
    JSON.stringify({ v: 1, generation: "not a generation" }),
    JSON.stringify({ v: 1, generation: "0".repeat(32), extra: true }),
  ]) {
    storage.setItem(headName("demo"), head);
    // Values of the original layout or another generation must not reappear.
    storage.setItem(itemName("demo", "answer"), JSON.stringify({ v: 1, value: "legacy" }));
    await assert.rejects(provider.load(), /unreadable/);
    await assert.rejects(provider.write("answer", "lost"), /unreadable/);
    // A replacement repairs the head.
    await provider.replace([{ key: "answer", value: "repaired" }]);
    assert.deepEqual(await provider.load(), [{ key: "answer", value: "repaired" }]);
  }
  assert.deepEqual(await other.load(), [{ key: "answer", value: "other scope" }]);
});

test("replacing and clearing keep scopes with shared prefixes apart and ignore generation-name aliases", async () => {
  const storage = new MemoryStorage();
  // Scopes whose encodings share a prefix, or look like part of an item-name tuple.
  const scopes = ["demo", "demo2", 'demo","x', "", 'demo"]'];
  for (const [index, scope] of scopes.entries())
    await createLocalScriptStorage(storage, scope).write("answer", index);
  const provider = createLocalScriptStorage(storage, "demo");
  await provider.replace([{ key: "answer", value: "replaced" }]);
  const generation = generationOf(storage, "demo");
  // An alias of a published item's name, with extra spaces, is never an entry, before or after a clear.
  storage.setItem(
    `player-storage-generation:[ "demo", "${generation}", "alias" ]`,
    JSON.stringify({ v: 1, value: "alias" }),
  );
  assert.deepEqual(await provider.load(), [{ key: "answer", value: "replaced" }]);
  await provider.clear();
  assert.deepEqual(await provider.load(), []);
  for (const [index, scope] of scopes.entries())
    if (scope !== "demo")
      assert.deepEqual(await createLocalScriptStorage(storage, scope).load(), [
        { key: "answer", value: index },
      ]);
});

test("a value nested deeper than native JSON recursion allows is saved, replaced, and loaded", async () => {
  let value: SerializableRuntimeValue = 1;
  for (let depth = 0; depth < 5_000; depth += 1) value = { kind: "list", items: [value] };
  // Compared as JSON text written without recursion, since a recursive comparison cannot reach the bottom.
  const json = (data: unknown) => serializeValidatedRuntimeJson(data);
  const storage = new MemoryStorage();
  const provider = createLocalScriptStorage(storage, "demo");
  await provider.write("deep", value);
  assert.equal(json(await provider.load()), json([{ key: "deep", value }]));
  await provider.replace([{ key: "replaced", value }]);
  assert.equal(
    json(await createLocalScriptStorage(storage, "demo").load()),
    json([{ key: "replaced", value }]),
  );
});
