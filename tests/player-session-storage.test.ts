import assert from "node:assert/strict";
import test, { before, type TestContext } from "node:test";
import { effectScope, nextTick, type Ref } from "vue";
import { createServer } from "vite";

import {
  activatePlayerRuntimeButton,
  createPlayerRuntimeRestorePoint,
  createPlayerRuntimeSession,
  pendingPlayerRuntimeStorageWrite,
  playerRuntimePacingGate,
  restorePlayerRuntimeSession,
  type PlayerRuntimeSession,
  type PlayerRuntimeSessionOptions,
  playerRuntimeSnapshot,
} from "../player/runtime-adapter.js";
import type { DebugRecorder } from "../player/debug-recorder.js";
import type { ScriptStorageProvider } from "../player/script-storage.js";
import {
  compileSource,
  createCheckpoint,
  createFreshRuntimeSnapshot,
  serializeCheckpoint,
  type InterpreterEvent,
  type SerializableRuntimeValue,
} from "../src/index.js";
import { DEFAULT_TEMPORAL_CONTEXT, type TemporalContext } from "../src/temporal.js";
import { AMSTERDAM, utc } from "./helpers/temporal-fixtures.js";

// Load the real Vue composable through the existing build tool: its browser-source imports use Vite resolution.
interface StorageHost {
  readonly session: Readonly<Ref<PlayerRuntimeSession | null>>;
  readonly canClearScriptStorage: Readonly<Ref<boolean>>;
  readonly activation: Readonly<Ref<"start" | "continue" | null>>;
  readonly notices: Readonly<Ref<readonly { readonly key: string; readonly level: string }[]>>;
  clearScriptStorage(): Promise<boolean>;
  observe(): PlayerRuntimeSession | null;
  publishNotice(notice: {
    readonly key: string;
    readonly level: "info" | "warning" | "error";
    readonly message: string;
    readonly dismissible?: boolean;
  }): void;
  dismissNotice(key: string): void;
  withdrawNotice(key: string): void;
  loadScriptStorage(): Promise<void>;
  scriptStorageOptions(): PlayerRuntimeSessionOptions;
  prepare(create: (recording: { readonly recorder: DebugRecorder }) => PlayerRuntimeSession): void;
  readonly canPlayAgain: Readonly<Ref<boolean>>;
  playAgain(): Promise<void>;
  debugRecording(): { readonly operations: readonly { readonly kind: string }[] } | null;
  prepareRestore(restored: PlayerRuntimeSession): void;
  activate(): void;
  update(session: PlayerRuntimeSession): void;
  temporalCapture(): { temporalContext: TemporalContext; wallClockMs: number };
  editSavedData(edit: {
    key: string;
    value: SerializableRuntimeValue;
    expected: SerializableRuntimeValue | undefined;
  }): Promise<
    | { kind: "saved"; live: boolean }
    | { kind: "busy" }
    | { kind: "overtaken" }
    | { kind: "changed" }
    | { kind: "failed"; message: string }
  >;
  readonly debugEdits: Readonly<Ref<{ firstEditSceneTimeMs: number; editCount: number } | null>>;
  debugExportCandidate(
    player: Record<string, never>,
  ): Promise<{
    readonly editedWhileDebugging: { firstEditSceneTimeMs: number; editCount: number } | null;
  }>;
}
let usePlayerSession: (options: {
  scriptStorage: ScriptStorageProvider;
  temporalContext?: () => TemporalContext;
}) => StorageHost;

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

function createHost(
  context: TestContext,
  provider: ScriptStorageProvider,
  temporalContext?: () => TemporalContext,
) {
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
  const host = scope.run(() =>
    usePlayerSession({
      scriptStorage: provider,
      ...(temporalContext === undefined ? {} : { temporalContext }),
    }),
  );
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
    replace: async () => {},
    clear: async () => {},
  });
  const pending = await start(host, 'save 1 as "first"\nsave 2 as "second"\nexit');
  assert.ok(pendingPlayerRuntimeStorageWrite(pending.state));
  host.update({ ...pending });
  host.update({ ...pending });
  assert.deepEqual(writes, [{ key: "first", value: 1 }]);

  persistence.resolve();
  await nextTick();
  assert.deepEqual(playerRuntimeSnapshot(host.session.value!).scriptStorage, []);
  assert.equal(host.session.value?.state.status, "waiting");
  assert.deepEqual(writes, [{ key: "first", value: 1 }]);

  context.mock.timers.tick(0);
  assert.deepEqual(writes, [
    { key: "first", value: 1 },
    { key: "second", value: 2 },
  ]);
  const second = host.session.value;
  assert.ok(second);
  assert.deepEqual(playerRuntimeSnapshot(second).scriptStorage, [{ key: "first", value: 1 }]);
  host.update({ ...second });
  await nextTick();
  assert.equal(writes.length, 2);
  assert.equal(host.session.value?.state.status, "waiting");
  context.mock.timers.tick(0);
  assert.equal(host.session.value?.state.status, "halted");
  assert.deepEqual(playerRuntimeSnapshot(host.session.value!).scriptStorage, [
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
    replace: async () => {},
    clear: async () => {},
  });
  const original = await start(host, 'save 1 as "answer"\nexit');
  const restarted = await start(host, 'save 2 as "answer"\nexit');
  assert.equal(
    pendingPlayerRuntimeStorageWrite(original.state)?.actionId,
    pendingPlayerRuntimeStorageWrite(restarted.state)?.actionId,
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
  assert.equal(host.session.value?.state.status, "halted");
  assert.deepEqual(playerRuntimeSnapshot(host.session.value!).scriptStorage, [
    { key: "answer", value: 2 },
  ]);
});

test("Vue host reports rejected writes in a later task and preserves the previous value", async (context) => {
  const persistence = deferred();
  const { host } = createHost(context, {
    scope: "test",
    load: async () => [{ key: "answer", value: "previous" }],
    write: () => persistence.promise,
    replace: async () => {},
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
  assert.equal(host.session.value?.state.status, "halted");
  assert.deepEqual(playerRuntimeSnapshot(host.session.value!).scriptStorage, [
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
  // The player learns through the notice channel that the progress was not kept.
  assert.deepEqual(
    host.notices.value.map(({ key, level }) => [key, level]),
    [["storage-write-failed", "warning"]],
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
      replace: async () => {},
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
    replace: async () => {},
    clear: async () => {},
  });
  const first = await start(host, 'let answer = load "answer"\nsay answer, instant\nexit');
  assert.equal(playerRuntimeSnapshot(first).scriptStoragePersistent, true);
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
  assert.equal(playerRuntimeSnapshot(local).scriptStoragePersistent, false);
  assert.equal(local.state.status, "halted");
  assert.equal(pendingPlayerRuntimeStorageWrite(local.state), null);
  assert.deepEqual(
    local.transcriptEntries.map((entry) => entry.text),
    ["local"],
  );
  assert.equal(host.canClearScriptStorage.value, false);
  assert.equal(writes, 0);
  assert.deepEqual(
    host.notices.value.map(({ key, level }) => [key, level]),
    [["storage-unavailable", "info"]],
  );

  const recovered = await start(host, 'let answer = load "answer"\nsay answer, instant\nexit');
  assert.equal(loads, 3);
  assert.equal(playerRuntimeSnapshot(recovered).scriptStoragePersistent, true);
  // A successful load withdraws the unavailable-storage notice.
  assert.deepEqual(host.notices.value, []);
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
    replace: async () => {},
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
  assert.deepEqual(playerRuntimeSnapshot(current()!).scriptStorage, []);
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
    replace: async () => {},
    clear: async () => {},
  });
  await start(
    host,
    'timer async 10 ms { say "one", instant }\ntimer async 20 ms { say "two", instant }\nsave 1 as "k"\nwait 100 ms\nexit',
  );
  now = 100;
  host.observe();
  // Catch-up holds at the first block's due time behind the write; an overdue deadline must not spin the clock.
  assert.equal(host.session.value?.state.currentSessionTimeMs, 10);
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
      replace: async () => {},
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

test("Vue host resolves the player's zone and presentation again at Start and at Continue", async (context) => {
  let account = AMSTERDAM;
  let resolved = 0;
  const { host } = createHost(
    context,
    {
      scope: "test",
      load: async () => [],
      write: async () => {},
      replace: async () => {},
      clear: async () => {},
    },
    () => {
      resolved++;
      return account;
    },
  );
  context.mock.method(Date, "now", () => utc("2026-10-04T16:00:00"));
  await host.loadScriptStorage();
  host.prepare(() =>
    createPlayerRuntimeSession('let day = choose [toDate("2026-10-04")]\nsay day\nexit', {
      ...host.scriptStorageOptions(),
      ...host.temporalCapture(),
    }),
  );
  host.activate();
  const started = host.session.value;
  assert.ok(started);
  assert.equal(
    playerRuntimeSnapshot(started).temporalCaptures[0]?.context.zone.name,
    "Europe/Amsterdam",
  );

  // The account setting changed before the player continued the saved session.
  account = DEFAULT_TEMPORAL_CONTEXT;
  context.mock.method(Date, "now", () => utc("2026-10-05T09:00:00"));
  host.prepareRestore(restorePlayerRuntimeSession(createPlayerRuntimeRestorePoint(started)));
  host.activate();
  const continued = playerRuntimeSnapshot(host.session.value!);
  assert.ok(continued);
  assert.equal(resolved, 2);
  assert.deepEqual(
    continued.temporalCaptures.map((capture) => [capture.context.zone.name, capture.epochMs]),
    [
      ["Europe/Amsterdam", utc("2026-10-04T16:00:00")],
      ["UTC", utc("2026-10-05T09:00:00")],
    ],
  );
  // The choice keeps the buttons it was shown with.
  const choice = continued.foregroundAction;
  assert.ok(choice?.kind === "interaction" && choice.ui.kind === "choice");
  assert.deepEqual(
    choice.ui.options.map((option) => option.text),
    ["4-10-2026"],
  );
});

test("Vue host's Continue resumes a restored ready session within the activating call", (context) => {
  const { host } = createHost(context, {
    scope: "test",
    load: async () => [],
    write: async () => {},
    replace: async () => {},
    clear: async () => {},
  });
  const { plan } = compileSource('say "Resumed", instant\nexit');
  assert.ok(plan);
  host.prepareRestore(
    restorePlayerRuntimeSession({
      checkpointJson: serializeCheckpoint(createCheckpoint(plan, createFreshRuntimeSnapshot(plan))),
      events: [],
    }),
  );
  const beforeActivation = host.session.value;
  assert.equal(host.activation.value, "continue");
  assert.equal(beforeActivation, null);

  // No timer, observation, or page lifecycle event is needed after the click.
  host.activate();
  assert.deepEqual(
    host.session.value?.transcriptEntries.map((entry) => entry.text),
    ["Resumed"],
  );
  assert.equal(host.session.value?.state.status, "halted");
});

test("Vue host scopes the write-failure notice to the run it happened in", async (context) => {
  const pendingWrites: ReturnType<typeof deferred>[] = [];
  const { host } = createHost(context, {
    scope: "test",
    load: async () => [],
    write: () => {
      const write = deferred();
      pendingWrites.push(write);
      return write.promise;
    },
    replace: async () => {},
    clear: async () => {},
  });
  // A rejection reported after its session was replaced says nothing about the current run.
  await start(host, 'save 1 as "k"\nexit');
  await start(host, 'save 2 as "k"\nexit');
  pendingWrites[0]!.reject(new Error("Write denied"));
  pendingWrites[1]!.resolve();
  await nextTick();
  context.mock.timers.tick(0);
  assert.deepEqual(host.notices.value, []);

  // A failure in the current run is reported, and a new Start withdraws it.
  await start(host, 'save 3 as "k"\nexit');
  pendingWrites[2]!.reject(new Error("Write denied"));
  await nextTick();
  context.mock.timers.tick(0);
  assert.deepEqual(
    host.notices.value.map(({ key }) => key),
    ["storage-write-failed"],
  );
  await start(host, "exit");
  assert.deepEqual(host.notices.value, []);
});

test("Vue host keeps a recovery notice until its condition resolves", async (context) => {
  const { host } = createHost(context, {
    scope: "test",
    load: async () => [],
    write: async () => {},
    replace: async () => {},
    clear: async () => {},
  });
  host.publishNotice({
    key: "needs-action",
    level: "warning",
    message: "Act.",
    dismissible: false,
  });
  host.dismissNotice("needs-action");
  assert.deepEqual(
    host.notices.value.map(({ key }) => key),
    ["needs-action"],
  );
  // Its producer withdraws it once the condition resolves.
  host.withdrawNotice("needs-action");
  assert.deepEqual(host.notices.value, []);
});

test("Vue host records every session from Start and from Continue for a debug export", async (context) => {
  const { host } = createHost(context, {
    scope: "test",
    load: async () => [],
    write: async () => {},
    replace: async () => {},
    clear: async () => {},
  });
  assert.equal(host.debugRecording(), null, "nothing is recorded before Start");
  await host.loadScriptStorage();
  host.prepare((recording) =>
    createPlayerRuntimeSession('let name = askText "Name"\nexit', recording),
  );
  host.activate();
  assert.deepEqual(
    host.debugRecording()?.operations.map((operation) => operation.kind),
    ["run"],
  );
  const started = host.session.value;
  assert.ok(started);
  host.prepareRestore(restorePlayerRuntimeSession(createPlayerRuntimeRestorePoint(started)));
  host.activate();
  assert.deepEqual(
    host.debugRecording()?.operations.map((operation) => operation.kind),
    ["recordContinueCapture", "run"],
    "a Continue starts a new recording from the restored state",
  );
});

/** Script storage in memory, as the browser provider keeps it; `writing` may hold or fail a write. */
function memoryStorage(
  initial: Record<string, SerializableRuntimeValue>,
  writing: (key: string, value: SerializableRuntimeValue) => Promise<void> = async () => {},
  loading: () => Promise<void> = async () => {},
) {
  const entries = new Map(Object.entries(initial));
  const writes: [string, SerializableRuntimeValue][] = [];
  const provider: ScriptStorageProvider = {
    scope: "test",
    load: async () => {
      await loading();
      return [...entries].map(([key, value]) => ({ key, value }));
    },
    write: async (key, value) => {
      writes.push([key, value]);
      await writing(key, value);
      if (value === null) entries.delete(key);
      else entries.set(key, value);
    },
    replace: async () => {},
    clear: async () => entries.clear(),
  };
  return { provider, entries, writes };
}

function said(session: PlayerRuntimeSession | null): string[] {
  return (session?.events ?? []).flatMap((event: InterpreterEvent) =>
    event.kind === "say" ? [event.text] : [],
  );
}

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
  assert.deepEqual((await host.debugExportCandidate({})).editedWhileDebugging, {
    firstEditSceneTimeMs: 0,
    editCount: 1,
  });
  host.update(activatePlayerRuntimeButton(host.session.value!)!.session);
  assert.deepEqual(said(host.session.value), ["1 2"]);
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

/** Lets every pending promise reaction and the write report's later task run. */
async function settleTasks(context: TestContext) {
  for (let turn = 0; turn < 5; turn += 1) await nextTick();
  context.mock.timers.tick(0);
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
  // A new run starts from the values already read; its Start does not wait for storage.
  host.prepare(() => createPlayerRuntimeSession(loadsAroundButton, host.scriptStorageOptions()));
  host.activate();
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
  host.activate();
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
    'save 1 as "k"\nlet loaded = load("k")\nsay "${loaded}", instant\nexit',
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
        `let go = showButton "Go"\nsave 1 as "${scriptKey}"\nlet again = showButton "Again"\nlet loaded = load("k")\nsay "\${loaded}", instant\nexit`,
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
  host.activate();
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
    'let go = showButton "Go"\nlet loaded = load("k")\nsay "${loaded}", instant\nexit',
  );
  assert.deepEqual(await host.editSavedData({ key: "k", value: 2, expected: 0 }), {
    kind: "saved",
    live: true,
  });
  host.update(activatePlayerRuntimeButton(host.session.value!)!.session);
  assert.deepEqual(said(host.session.value), ["2"]);
  assert.equal(storage.entries.get("k"), 2);
});

test("Play again starts from the values the previous run saved and deleted", async (context) => {
  const stored = new Map<string, SerializableRuntimeValue>([["gone", "old"]]);
  const { host } = createHost(context, {
    scope: "test",
    load: async () => [...stored].map(([key, value]) => ({ key, value })),
    write: async (key, value) => {
      if (value === null) stored.delete(key);
      else stored.set(key, value);
    },
    replace: async () => {},
    clear: async () => {},
  });
  // Each stored write reports in a later task; play on until the run ends.
  const playOut = async () => {
    for (let step = 0; step < 10 && host.session.value?.state.status !== "halted"; step++) {
      await nextTick();
      context.mock.timers.tick(0);
    }
    assert.equal(host.session.value?.state.status, "halted");
    return host.session.value!.transcriptEntries.at(-1)?.text;
  };
  await start(
    host,
    [
      'let runs = load("runs", default: 0) + 1',
      'let gone = load("gone", default: "none")',
      'save runs as "runs"',
      'delete "gone"',
      'say "${runs} ${gone}", instant',
      "exit",
    ].join("\n"),
  );
  assert.equal(await playOut(), "1 old");
  assert.equal(host.canPlayAgain.value, true);
  await host.playAgain();
  assert.equal(await playOut(), "2 none");
  assert.deepEqual([...stored], [["runs", 2]]);
});
