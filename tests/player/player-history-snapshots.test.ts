import assert from "node:assert/strict";
import test from "node:test";

import {
  DEBUG_HISTORY_ADMITTED_SNAPSHOT_CHARS,
  SnapshotStore,
  type DebugHistorySpill,
} from "../../player/engine-bridge/history/snapshots.js";

/*
 * The history's snapshot store, written through to its spill (`player/engine-bridge/history/snapshots.ts`): admission
 * counts memory and pending writes against the budget, a memory copy goes only once its write completed, no store is a
 * memory-only history, and a write failure is reported once.
 */

/** A spill that holds its rows in memory, with each put waiting for `gate` when one is set. */
function spill(options: { readonly failPut?: boolean } = {}) {
  const rows = new Map<number, string>();
  let gate: Promise<void> | null = null;
  let open!: () => void;
  const store: DebugHistorySpill = {
    put: async (id, json) => {
      if (gate !== null) await gate;
      if (options.failPut) throw new DOMException("The quota is exceeded.", "QuotaExceededError");
      rows.set(id, json);
    },
    get: async (id) => rows.get(id),
    delete: async (ids) => ids.forEach((id) => rows.delete(id)),
    destroy: async () => rows.clear(),
  };
  return {
    store,
    rows,
    hold: () => void (gate = new Promise<void>((resolve) => (open = resolve))),
    release: () => {
      open();
      gate = null;
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const text = (units: number, fill = "a") => fill.repeat(units);

test("without a spill store, the history is memory-only and admission alone bounds it", async () => {
  const store = new SnapshotStore(() => Promise.resolve(null), 3_000);
  assert.equal(store.add(1, text(1_000)), true);
  assert.equal(store.add(2, text(1_000)), true);
  assert.equal(store.add(3, text(1_000)), true);
  assert.equal(store.add(4, text(1)), false, "refused past the bound");
  await settle();
  assert.equal(store.memoryChars, 3_000);
  assert.equal(await store.get(1), text(1_000));
});

test("while the spill opens, pending snapshots count against the bound, so it is never overshot", async () => {
  let opened!: (value: DebugHistorySpill | null) => void;
  const store = new SnapshotStore(() => new Promise((resolve) => (opened = resolve)), 1_024);
  let admitted = 0;
  for (let id = 0; id < 100; id += 1) if (store.add(id, text(1_024))) admitted += 1;
  assert.equal(admitted, 1, "one snapshot fits; the rest are refused while it is pending");
  assert.equal(store.memoryChars, 1_024);
  await settle();
  opened(null);
  await settle();
  assert.equal(store.memoryChars, 1_024, "an absent store keeps it in memory");
});

test("a completed write drops its memory copy, so admission goes on, and the spill serves it", async () => {
  const { store: target, rows } = spill();
  const store = new SnapshotStore(() => Promise.resolve(target), 2_000);
  for (let id = 0; id < 10; id += 1) {
    assert.equal(store.add(id, text(1_000, String(id))), true, `point ${id}`);
    await settle();
  }
  assert.equal(store.memoryChars, 0, "every write completed");
  assert.equal(store.spilledCount, 10);
  assert.equal(rows.size, 10);
  assert.equal(await store.get(3), text(1_000, "3"));
});

test("a pending write keeps its copy counted until it completes", async () => {
  const { store: target, hold, release } = spill();
  const store = new SnapshotStore(() => Promise.resolve(target), 2_000);
  await settle();
  hold();
  assert.equal(store.add(1, text(1_500)), true);
  assert.equal(store.add(2, text(1_000)), false, "the pending write still counts");
  release();
  await settle();
  await settle();
  assert.equal(store.memoryChars, 0);
  assert.equal(store.add(2, text(1_000)), true);
});

test("a failed write is reported once; its snapshot stays readable, and no later one is written", async () => {
  const { store: target, rows } = spill({ failPut: true });
  let failures = 0;
  const store = new SnapshotStore(
    () => Promise.resolve(target),
    10_000,
    () => (failures += 1),
  );
  store.add(1, text(100));
  store.add(2, text(100));
  await settle();
  await settle();
  assert.equal(failures, 1);
  assert.equal(rows.size, 0);
  assert.equal(await store.get(1), text(100), "kept in memory");
  assert.equal(store.memoryChars, 200);
});

test("a snapshot deleted while its write runs leaves no row; destroy during a write leaves none either", async () => {
  const first = spill();
  const store = new SnapshotStore(() => Promise.resolve(first.store), 10_000);
  await settle();
  first.hold();
  store.add(1, text(100));
  await settle();
  store.delete([1]);
  first.release();
  await settle();
  await settle();
  assert.equal(first.rows.has(1), false);
  assert.equal(store.memoryChars, 0);

  const second = spill();
  const destroyed = new SnapshotStore(() => Promise.resolve(second.store), 10_000);
  await settle();
  second.hold();
  destroyed.add(1, text(100));
  await settle();
  const ending = destroyed.destroy();
  second.release();
  await ending;
  assert.equal(second.rows.size, 0);
  assert.equal(destroyed.add(2, text(1)), false, "a destroyed store admits nothing");
});

test("the spill opens at the first admission, so a store that admitted nothing opens and destroys none", async () => {
  const { store: target } = spill();
  let opens = 0;
  let destroys = 0;
  const open = () => {
    opens += 1;
    return Promise.resolve({ ...target, destroy: async () => void (destroys += 1) });
  };
  const empty = new SnapshotStore(open, 10_000);
  await empty.destroy();
  assert.deepEqual([opens, destroys], [0, 0]);
  const used = new SnapshotStore(open, 10_000);
  used.add(1, text(10));
  used.add(2, text(10));
  await settle();
  await used.destroy();
  assert.deepEqual([opens, destroys], [1, 1]);
});

test("a store's budget is the admission bound unless a test gives another", () => {
  assert.equal(DEBUG_HISTORY_ADMITTED_SNAPSHOT_CHARS, 32 * 1024 * 1024);
  assert.equal(
    new SnapshotStore(() => Promise.resolve(null)).budget,
    DEBUG_HISTORY_ADMITTED_SNAPSHOT_CHARS,
  );
});
