import assert from "node:assert/strict";
import test from "node:test";

import { createLocalScriptStorage } from "../player/script-storage.js";
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
  assert.equal(storage.length, 2);
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
  class QuotaStorage extends MemoryStorage {
    rejectWrites = false;

    override setItem(key: string, value: string): void {
      if (this.rejectWrites) throw new Error("Quota exceeded");
      super.setItem(key, value);
    }
  }
  const storage = new QuotaStorage();
  storage.setItem(itemName("demo", "answer"), '{"v":1,"value":41}');
  storage.rejectWrites = true;
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
    await assert.rejects(provider.clear());
  }
});
