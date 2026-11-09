/*
 * Debug's edits of saved values on the session host: stored first, then given to the running session's next load.
 */

import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { nextTick } from "vue";
import { activatePlayerRuntimeButton as rawActivatePlayerRuntimeButton } from "../../player/runtime/runtime-adapter.js";
import { createPlayerRuntimeSession } from "../../player/runtime/compile-project.js";
import { pendingPlayerRuntimeStorageWrite } from "../../player/runtime/runtime-view.js";
import type { ScriptStorageProvider } from "../../player/persistence/script-storage.js";
import type { SerializableRuntimeValue } from "../../src/index.js";
import { decodeMessage, encodeMessage } from "../../player/engine-bridge/transport.js";
import { cloneGraphDifference } from "../helpers/clone-graph.js";
import { onHost } from "../helpers/player/host-sessions.js";
import {
  playerRuntimeSnapshot,
  acknowledged,
  deferred,
  createHost,
  start,
  memoryStorage,
  said,
} from "../helpers/player/storage-host.js";

// The adapter's functions, also on the sessions the composables' host holds (`helpers/player/host-sessions.ts`).
const activatePlayerRuntimeButton = onHost(rawActivatePlayerRuntimeButton);

const loadsAroundButton =
  'let first = load("k", default: 0)\nlet go = showButton "Go"\nlet second = load("k", default: 0)\nsay "${first} ${second}", instant\nexit';

test("a Debug edit is stored first, and the running session's next load returns it", async (context) => {
  const storage = memoryStorage({ k: 1 });
  const { host } = createHost(context, storage.provider);
  await start(host, loadsAroundButton);
  assert.deepEqual(await host.editSavedData({ key: "k", value: 2, expected: 1 }), {
    kind: "saved",
    live: true,
  });
  assert.deepEqual([...storage.entries], [["k", 2]]);
  assert.deepEqual(playerRuntimeSnapshot(host.session.value!).scriptStorage, [
    { key: "k", value: 2 },
  ]);
  assert.deepEqual(host.debugEdits.value, { firstEditSceneTimeMs: 0, editCount: 1 });
  // A debug export of this session carries the mark.
  assert.deepEqual(
    (await host.debugExportCandidate(() => ({}), new AbortController().signal))
      .editedWhileDebugging,
    { firstEditSceneTimeMs: 0, editCount: 1 },
  );
  host.update(activatePlayerRuntimeButton(host.session.value!)!.session);
  assert.deepEqual(said(host.session.value), ["1 2"]);
});

test("a Debug edit 2,000 lists deep is stored, crosses the bridge and reaches the running session (#1877)", async (context) => {
  let deep: SerializableRuntimeValue = 2;
  for (let level = 0; level < 2_000; level += 1) deep = { kind: "list", items: [deep] };
  const storage = memoryStorage({ k: 1 });
  const { host } = createHost(context, storage.provider);
  await start(host, loadsAroundButton);
  assert.deepEqual(await host.editSavedData({ key: "k", value: deep, expected: 1 }), {
    kind: "saved",
    live: true,
  });
  assert.equal(cloneGraphDifference(storage.entries.get("k"), deep), null, "stored");
  const [entry] = playerRuntimeSnapshot(host.session.value!).scriptStorage;
  assert.equal(entry?.key, "k");
  // The host's value is engine data, whose arrays have the runtime's captured-array prototype, so it is compared as it
  // crosses the bridge: `cloneGraphDifference` compares what crossed a structured-clone port.
  const crossed = decodeMessage(structuredClone(encodeMessage(entry?.value)));
  assert.equal(cloneGraphDifference(crossed, deep), null, "in the host's session");
  assert.deepEqual(host.debugEdits.value, { firstEditSceneTimeMs: 0, editCount: 1 });
});

test("a value changed meanwhile is reported, and an edit that cannot be stored changes nothing", async (context) => {
  const storage = memoryStorage({ k: 1 }, async (key) => {
    if (key === "k") throw new Error("quota");
  });
  const { host } = createHost(context, storage.provider);
  const session = await start(host, loadsAroundButton);
  assert.deepEqual(await host.editSavedData({ key: "k", value: 2, expected: 5 }), {
    kind: "changed",
  });
  assert.deepEqual(storage.writes, []);
  const failed = await host.editSavedData({ key: "k", value: 2, expected: 1 });
  assert.equal(failed.kind, "failed");
  assert.deepEqual([...storage.entries], [["k", 1]]);
  assert.equal(host.session.value, session);
  assert.equal(host.debugEdits.value, null);
});

test("without a running session, an edit is stored for the next Start", async (context) => {
  const storage = memoryStorage({ k: 1 });
  const { host } = createHost(context, storage.provider);
  await host.loadScriptStorage();
  assert.deepEqual(await host.editSavedData({ key: "k", value: null, expected: 1 }), {
    kind: "saved",
    live: false,
  });
  assert.deepEqual([...storage.entries], []);
  await start(host, 'let k = load("k", default: 9)\nsay "${k}", instant\nexit');
  assert.deepEqual(said(host.session.value), ["9"]);
  assert.equal(host.debugEdits.value, null);
});

test("a saved value too long to write as text is compared without writing it, so its edit is stored", async (context) => {
  const large: SerializableRuntimeValue = { kind: "list", items: ["too long"] };
  const storage = memoryStorage({ k: large });
  const { host } = createHost(context, storage.provider);
  await host.loadScriptStorage();
  // V8 cannot build a text longer than its limit; this list stands for one whose JSON would be longer.
  const stringify = JSON.stringify;
  context.mock.method(JSON, "stringify", (value: unknown, ...rest: []) => {
    if (typeof value === "object" && value !== null && "items" in value)
      throw new RangeError("Invalid string length");
    return stringify(value, ...rest);
  });
  assert.deepEqual(await host.editSavedData({ key: "k", value: 2, expected: large }), {
    kind: "saved",
    live: false,
  });
  assert.deepEqual([...storage.entries], [["k", 2]]);
});

/** Lets every pending promise reaction and the write report's later task run. */
async function settleTasks(context: TestContext) {
  for (let turn = 0; turn < 5; turn += 1) await nextTick();
  context.mock.timers.tick(0);
  await acknowledged();
  for (let turn = 0; turn < 5; turn += 1) await nextTick();
}

test("an edit of a session that was replaced or unmounted meanwhile changes neither", async (context) => {
  const firstRead = deferred();
  let reads = 0;
  const storage = memoryStorage(
    { k: 1 },
    async () => {},
    async () => {
      reads += 1;
      if (reads === 2) await firstRead.promise;
    },
  );
  const { host } = createHost(context, storage.provider);
  await start(host, loadsAroundButton);
  // The edit reads the stored values while a new run replaces the session.
  const edit = host.editSavedData({ key: "k", value: 2, expected: 1 });
  for (let turn = 0; turn < 5; turn += 1) await nextTick();
  assert.equal(reads, 2);
  host.prepare(() => createPlayerRuntimeSession(loadsAroundButton, host.scriptStorageOptions()));
  await host.activate();
  const replaced = host.session.value!;
  firstRead.resolve();
  assert.equal((await edit).kind, "failed");
  assert.deepEqual(storage.writes, []);
  assert.deepEqual(playerRuntimeSnapshot(host.session.value!), playerRuntimeSnapshot(replaced));
  assert.equal(host.debugEdits.value, null);
});

test("an edit stored while Start is prepared is what that Start loads", async (context) => {
  const storage = memoryStorage({ k: 1 });
  const { host } = createHost(context, storage.provider);
  await host.loadScriptStorage();
  host.prepare(() =>
    createPlayerRuntimeSession(
      'let k = load("k", default: 0)\nsay "${k}", instant\nexit',
      host.scriptStorageOptions(),
    ),
  );
  assert.deepEqual(await host.editSavedData({ key: "k", value: 2, expected: 1 }), {
    kind: "saved",
    live: false,
  });
  await host.activate();
  assert.deepEqual(said(host.session.value), ["2"]);
});

test("while the script's own write waits for the host, an edit is not taken and stores nothing", async (context) => {
  const scriptWrite = deferred();
  const storage = memoryStorage({}, async (_key, value) => {
    if (value === 1) await scriptWrite.promise;
  });
  const { host } = createHost(context, storage.provider);
  const pending = await start(
    host,
    'save 1 as "k"\nlet loaded: integer? = load("k", default: null)\nsay "${loaded}", instant\nexit',
  );
  assert.deepEqual(await host.editSavedData({ key: "k", value: 2, expected: undefined }), {
    kind: "busy",
  });
  assert.deepEqual(storage.writes, [["k", 1]]);
  assert.equal(host.session.value, pending);
  scriptWrite.resolve();
  await settleTasks(context);
  assert.deepEqual(said(host.session.value), ["1"]);
});

test("a write the script issues while an edit is stored settles first: another key's edit follows, the same key's yields unless it failed", async (context) => {
  for (const [scriptKey, scriptStores] of [
    ["other", true],
    ["k", true],
    ["k", false],
  ] as const) {
    await context.test(`${scriptKey}, ${scriptStores ? "stored" : "failed"}`, async (subtest) => {
      const editWrite = deferred();
      const storage = memoryStorage({ k: 0 }, async (key, value) => {
        if (key === "k" && value === 2) await editWrite.promise;
        if (value === 1 && !scriptStores) throw new Error("quota");
      });
      // Like the Player's providers, this one stores writes in the order they were issued.
      let queue = Promise.resolve();
      const ordered: ScriptStorageProvider = {
        ...storage.provider,
        write: (key, value) => (queue = queue.then(() => storage.provider.write(key, value))),
      };
      const { host } = createHost(subtest, ordered);
      await start(
        host,
        `let go = showButton "Go"\nsave 1 as "${scriptKey}"\nlet again = showButton "Again"\nlet loaded: integer? = load("k", default: null)\nsay "\${loaded}", instant\nexit`,
      );
      const edit = host.editSavedData({ key: "k", value: 2, expected: 0 });
      for (let turn = 0; turn < 5; turn += 1) await nextTick();
      // The script goes on and saves while the edit is being stored.
      host.update(activatePlayerRuntimeButton(host.session.value!)!.session);
      assert.ok(pendingPlayerRuntimeStorageWrite(host.session.value!.state));
      editWrite.resolve();
      let result: unknown;
      void edit.then((settled) => (result = settled));
      for (let turn = 0; turn < 5 && result === undefined; turn += 1) await settleTasks(subtest);
      host.update(activatePlayerRuntimeButton(host.session.value!)!.session);
      if (scriptKey === "other" || !scriptStores) {
        assert.deepEqual(result, { kind: "saved", live: true });
        assert.deepEqual(said(host.session.value), ["2"]);
        assert.equal(storage.entries.get("k"), 2);
      } else {
        assert.deepEqual(result, { kind: "overtaken" });
        assert.deepEqual(said(host.session.value), ["1"]);
        assert.equal(storage.entries.get("k"), 1);
      }
    });
  }
});

test("an unmounted Player never publishes an edit it was storing", async (context) => {
  for (const outcome of ["stored", "failed"] as const) {
    await context.test(outcome, async (subtest) => {
      const editWrite = deferred();
      const storage = memoryStorage({ k: 1 }, async (_key, value) => {
        if (value === 2) await editWrite.promise;
      });
      const { host, scope } = createHost(subtest, storage.provider);
      const waiting = await start(host, loadsAroundButton);
      const edit = host.editSavedData({ key: "k", value: 2, expected: 1 });
      for (let turn = 0; turn < 5; turn += 1) await nextTick();
      scope.stop();
      if (outcome === "stored") editWrite.resolve();
      else editWrite.reject(new Error("quota"));
      await edit;
      assert.equal(host.session.value, waiting, outcome);
      assert.equal(host.debugEdits.value, null, outcome);
    });
  }
});

test("a new run releases an edit that waits for the old run's write, also while the new run saves", async (context) => {
  const holds = new Map([2, 1, 3].map((value) => [value, deferred()]));
  const storage = memoryStorage({ k: 0 }, async (_key, value) => {
    if (typeof value === "number") await holds.get(value)?.promise;
  });
  let queue = Promise.resolve();
  const ordered: ScriptStorageProvider = {
    ...storage.provider,
    write: (key, value) => (queue = queue.then(() => storage.provider.write(key, value))),
  };
  const { host } = createHost(context, ordered);
  await start(
    host,
    'let go = showButton "Go"\nsave 1 as "other"\nlet again = showButton "Again"\nexit',
  );
  let result: unknown;
  void host
    .editSavedData({ key: "k", value: 2, expected: 0 })
    .then((settled) => (result = settled));
  for (let turn = 0; turn < 5; turn += 1) await nextTick();
  host.update(activatePlayerRuntimeButton(host.session.value!)!.session);
  holds.get(2)!.resolve();
  await settleTasks(context);
  assert.equal(result, undefined);
  host.prepare(() =>
    createPlayerRuntimeSession('save 3 as "newer"\nexit', host.scriptStorageOptions()),
  );
  await host.activate();
  for (let turn = 0; turn < 5 && result === undefined; turn += 1) await settleTasks(context);
  assert.deepEqual(result, { kind: "saved", live: false });
  assert.deepEqual(await host.editSavedData({ key: "k", value: 4, expected: 2 }), { kind: "busy" });
  // Neither edit wrote again; the new run's own write waits behind the old run's in the provider.
  assert.deepEqual(storage.writes, [
    ["k", 2],
    ["other", 1],
  ]);
});

test("a stored edit reaches the session even when storage cannot be read afterwards", async (context) => {
  let reads = 0;
  const storage = memoryStorage(
    { k: 0 },
    async () => {},
    async () => {
      reads += 1;
      if (reads > 2) throw new Error("unreadable");
    },
  );
  const { host } = createHost(context, storage.provider);
  await start(
    host,
    'let go = showButton "Go"\nlet loaded: integer? = load("k", default: null)\nsay "${loaded}", instant\nexit',
  );
  assert.deepEqual(await host.editSavedData({ key: "k", value: 2, expected: 0 }), {
    kind: "saved",
    live: true,
  });
  host.update(activatePlayerRuntimeButton(host.session.value!)!.session);
  assert.deepEqual(said(host.session.value), ["2"]);
  assert.equal(storage.entries.get("k"), 2);
});
