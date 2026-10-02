import assert from "node:assert/strict";
import test, { before, type TestContext } from "node:test";
import { effectScope, nextTick, type Ref } from "vue";
import { createServer } from "vite";

import {
  createPlayerRuntimeSession,
  pendingPlayerRuntimeStorageWrite,
  playerRuntimePacingGate,
  type PlayerRuntimeSession,
  type PlayerRuntimeSessionOptions,
} from "../player/runtime-adapter.js";
import type { ScriptStorageProvider } from "../player/script-storage.js";

// Load the real Vue composable through the existing build tool: its browser-source imports use Vite resolution.
interface StorageHost {
  readonly session: Readonly<Ref<PlayerRuntimeSession | null>>;
  readonly canClearScriptStorage: Readonly<Ref<boolean>>;
  readonly activation: Readonly<Ref<"start" | "continue" | null>>;
  clearScriptStorage(): Promise<boolean>;
  observe(): PlayerRuntimeSession | null;
  loadScriptStorage(): Promise<void>;
  scriptStorageOptions(): PlayerRuntimeSessionOptions;
  prepare(create: () => PlayerRuntimeSession): void;
  activate(): void;
  update(session: PlayerRuntimeSession): void;
}
let usePlayerSession: (options: { scriptStorage: ScriptStorageProvider }) => StorageHost;

before(async () => {
  const server = await createServer({
    configFile: false,
    logLevel: "warn",
    // No HMR websocket: parallel test runs must not compete for its default port.
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true },
  });
  try {
    const module: Record<string, unknown> = await server.ssrLoadModule(
      "/player/vue/src/usePlayerSession.ts",
    );
    assert.equal(typeof module.usePlayerSession, "function");
    // EVIDENCE: validation: Vite loaded the real source module and the export is callable; this is its tested host API.
    usePlayerSession = module.usePlayerSession as typeof usePlayerSession;
  } finally {
    await server.close();
  }
});

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function createHost(context: TestContext, provider: ScriptStorageProvider) {
  // Event targets are the only browser surface these storage-only scripts use; no media elements are created.
  for (const name of ["document", "window"]) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value: new EventTarget() });
    context.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const scope = effectScope();
  const host = scope.run(() => usePlayerSession({ scriptStorage: provider }));
  assert.ok(host);
  context.after(() => scope.stop());
  return { host, scope };
}

async function start(host: StorageHost, source: string) {
  await host.loadScriptStorage();
  host.prepare(() => createPlayerRuntimeSession(source, host.scriptStorageOptions()));
  host.activate();
  assert.ok(host.session.value);
  return host.session.value;
}

test("Vue host writes each pending action once and continues only in a later task", async (context) => {
  const writes: { key: string; value: unknown }[] = [];
  const persistence = deferred();
  const { host } = createHost(context, {
    scope: "test",
    load: async () => [],
    write: (key, value) => {
      writes.push({ key, value });
      return persistence.promise;
    },
    clear: async () => {},
  });
  const pending = await start(host, 'save 1 as "first"\nsave 2 as "second"\nexit');
  assert.ok(pendingPlayerRuntimeStorageWrite(pending.snapshot));
  host.update({ ...pending });
  host.update({ ...pending });
  assert.deepEqual(writes, [{ key: "first", value: 1 }]);

  persistence.resolve();
  await nextTick();
  assert.deepEqual(host.session.value?.snapshot.scriptStorage, []);
  assert.equal(host.session.value?.snapshot.status, "waiting");
  assert.deepEqual(writes, [{ key: "first", value: 1 }]);

  context.mock.timers.tick(0);
  assert.deepEqual(writes, [
    { key: "first", value: 1 },
    { key: "second", value: 2 },
  ]);
  const second = host.session.value;
  assert.ok(second);
  assert.deepEqual(second.snapshot.scriptStorage, [{ key: "first", value: 1 }]);
  host.update({ ...second });
  await nextTick();
  assert.equal(writes.length, 2);
  assert.equal(host.session.value?.snapshot.status, "waiting");
  context.mock.timers.tick(0);
  assert.equal(host.session.value?.snapshot.status, "halted");
  assert.deepEqual(host.session.value?.snapshot.scriptStorage, [
    { key: "first", value: 1 },
    { key: "second", value: 2 },
  ]);
});

test("Vue host deduplicates by generation and ignores a replaced session's write report", async (context) => {
  const reports = [deferred(), deferred()];
  const writes: { key: string; value: unknown }[] = [];
  const { host } = createHost(context, {
    scope: "test",
    load: async () => [],
    write: (key, value) => {
      const report = reports[writes.length];
      assert.ok(report);
      writes.push({ key, value });
      return report.promise;
    },
    clear: async () => {},
  });
  const original = await start(host, 'save 1 as "answer"\nexit');
  const restarted = await start(host, 'save 2 as "answer"\nexit');
  assert.equal(
    pendingPlayerRuntimeStorageWrite(original.snapshot)?.actionId,
    pendingPlayerRuntimeStorageWrite(restarted.snapshot)?.actionId,
  );
  host.update({ ...restarted });
  assert.deepEqual(writes, [
    { key: "answer", value: 1 },
    { key: "answer", value: 2 },
  ]);

  reports[0]!.resolve();
  await nextTick();
  context.mock.timers.tick(0);
  assert.deepEqual(host.session.value, restarted);
  reports[1]!.resolve();
  await nextTick();
  context.mock.timers.tick(0);
  assert.equal(host.session.value?.snapshot.status, "halted");
  assert.deepEqual(host.session.value?.snapshot.scriptStorage, [{ key: "answer", value: 2 }]);
});

test("Vue host reports rejected writes in a later task and preserves the previous value", async (context) => {
  const persistence = deferred();
  const { host } = createHost(context, {
    scope: "test",
    load: async () => [{ key: "answer", value: "previous" }],
    write: () => persistence.promise,
    clear: async () => {},
  });
  const pending = await start(
    host,
    'save "new" as "answer"\nlet answer = load "answer"\nsay answer, instant\nexit',
  );
  persistence.reject(new Error("Write denied"));
  await nextTick();
  assert.deepEqual(host.session.value, pending);
  context.mock.timers.tick(0);
  assert.equal(host.session.value?.snapshot.status, "halted");
  assert.deepEqual(host.session.value?.snapshot.scriptStorage, [
    { key: "answer", value: "previous" },
  ]);
  assert.deepEqual(
    host.session.value?.transcriptEntries.map((entry) => entry.text),
    ["previous"],
  );
  assert.ok(
    host.session.value?.events.some(
      (event) => event.kind === "developerWarning" && event.code === "TSW014",
    ),
  );
});

for (const settleBeforeDisposal of [false, true]) {
  test(`Vue host never continues after disposal ${settleBeforeDisposal ? "with a report already queued" : "while a write is unresolved"}`, async (context) => {
    const persistence = deferred();
    let writes = 0;
    const { host, scope } = createHost(context, {
      scope: "test",
      load: async () => [],
      write: () => {
        writes++;
        return persistence.promise;
      },
      clear: async () => {},
    });
    const pending = await start(host, 'save 1 as "answer"\nsave 2 as "next"\nexit');
    if (settleBeforeDisposal) {
      persistence.resolve();
      await nextTick();
    }
    scope.stop();
    if (!settleBeforeDisposal) persistence.resolve();
    await nextTick();
    context.mock.timers.tick(0);
    assert.deepEqual(host.session.value, pending);
    assert.equal(writes, 1);
  });
}

test("Vue host reloads before each Start and falls back to session-local storage after load rejection", async (context) => {
  let loads = 0;
  let writes = 0;
  const { host } = createHost(context, {
    scope: "test",
    load: async () => {
      loads++;
      if (loads === 2) throw new Error("Read denied");
      return [{ key: "answer", value: loads }];
    },
    write: async () => {
      writes++;
    },
    clear: async () => {},
  });
  const first = await start(host, 'let answer = load "answer"\nsay answer, instant\nexit');
  assert.equal(first.snapshot.scriptStoragePersistent, true);
  assert.deepEqual(
    first.transcriptEntries.map((entry) => entry.text),
    ["1"],
  );
  assert.equal(host.canClearScriptStorage.value, true);

  const local = await start(
    host,
    'save "local" as "answer"\nlet answer = load "answer"\nsay answer, instant\nexit',
  );
  assert.deepEqual(host.scriptStorageOptions(), {});
  assert.equal(local.snapshot.scriptStoragePersistent, false);
  assert.equal(local.snapshot.status, "halted");
  assert.equal(pendingPlayerRuntimeStorageWrite(local.snapshot), null);
  assert.deepEqual(
    local.transcriptEntries.map((entry) => entry.text),
    ["local"],
  );
  assert.equal(host.canClearScriptStorage.value, false);
  assert.equal(writes, 0);

  const recovered = await start(host, 'let answer = load "answer"\nsay answer, instant\nexit');
  assert.equal(loads, 3);
  assert.equal(recovered.snapshot.scriptStoragePersistent, true);
  assert.deepEqual(
    recovered.transcriptEntries.map((entry) => entry.text),
    ["3"],
  );
});

test("Vue host clears once, and no Start begins until the clear settles", async (context) => {
  const clearing = deferred();
  let clears = 0;
  const { host } = createHost(context, {
    scope: "test",
    load: async () => [{ key: "answer", value: "old" }],
    write: async () => {},
    clear: () => {
      clears++;
      return clearing.promise;
    },
  });
  await host.loadScriptStorage();
  host.prepare(() =>
    createPlayerRuntimeSession('let answer = load "answer"\nexit', host.scriptStorageOptions()),
  );
  const first = host.clearScriptStorage();
  assert.equal(host.canClearScriptStorage.value, false);
  assert.equal(await host.clearScriptStorage(), false);
  assert.equal(host.activation.value, null);
  // Read through a function: an assertion narrows the reactive value's type for the rest of the test.
  const current = (): PlayerRuntimeSession | null => host.session.value;
  host.activate();
  assert.equal(current(), null);

  clearing.resolve();
  assert.equal(await first, true);
  assert.equal(clears, 1);
  assert.equal(host.activation.value, "start");
  host.activate();
  // The session starts from the cleared view, not from the values loaded before the clear.
  assert.deepEqual(current()?.snapshot.scriptStorage, []);
});

test("Vue host schedules no clock wake-ups while a pending write holds scene time", async (context) => {
  const persistence = deferred();
  let now = 0;
  const realNow = performance.now.bind(performance);
  performance.now = () => now;
  context.after(() => (performance.now = realNow));
  const { host } = createHost(context, {
    scope: "test",
    load: async () => [],
    write: () => persistence.promise,
    clear: async () => {},
  });
  await start(
    host,
    'timer async 10 ms { say "one", instant }\ntimer async 20 ms { say "two", instant }\nsave 1 as "k"\nwait 100 ms',
  );
  now = 100;
  host.observe();
  // Catch-up holds at the first block's due time behind the write; an overdue deadline must not spin the clock.
  assert.equal(host.session.value?.snapshot.currentSessionTimeMs, 10);
  const held = host.session.value;
  // The clock reschedules from a pre-flush watcher, so each step lets Vue run it before timers advance.
  for (let tick = 0; tick < 25; tick++) {
    await nextTick();
    context.mock.timers.tick(0);
  }
  assert.equal(host.session.value, held);

  persistence.resolve();
  await nextTick();
  context.mock.timers.tick(0);
  // After the acknowledgement both blocks run at their due times and the clock schedules the wait again.
  assert.deepEqual(
    host.session.value?.transcriptEntries.map((entry) => entry.text),
    ["one", "two"],
  );
});

for (const [name, source, expected] of [
  // Without a queued block, an elapsed background pacing gate settles while the write waits.
  [
    "an elapsed pacing gate settles",
    'say "before", 1\nsave 1 as "k"\nsay "after", instant\nexit',
    ["before", "after"],
  ],
  // A due block waits for the write, then runs at its time before the script continues and ends.
  [
    "a due block runs before the script continues",
    'timer async 10 ms { say "due", instant }\nsave 1 as "k"\nsay "main", instant\nexit',
    ["due", "main"],
  ],
] as const) {
  test(`Vue host still observes deadlines while a slow write waits: ${name}`, async (context) => {
    let now = 0;
    context.mock.method(performance, "now", () => now);
    const persistence = deferred();
    const { host } = createHost(context, {
      scope: "test",
      load: async () => [],
      write: () => persistence.promise,
      clear: async () => {},
    });
    await start(host, source);
    await nextTick();
    now = 2_000;
    context.mock.timers.tick(2_000);
    await nextTick();
    if (source.startsWith("say")) {
      const waiting: PlayerRuntimeSession | null = host.session.value;
      assert.equal(playerRuntimePacingGate(waiting!), null);
    }
    persistence.resolve();
    await nextTick();
    context.mock.timers.tick(0);
    assert.deepEqual(
      host.session.value?.transcriptEntries.map((entry) => entry.text),
      expected,
    );
  });
}
