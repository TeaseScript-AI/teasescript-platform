import assert from "node:assert/strict";
import test, { before, type TestContext } from "node:test";
import { effectScope, type Ref } from "vue";
import { createServer } from "vite";

import {
  activatePlayerRuntimeButton,
  compilePlayerProject,
  createPlayerRuntimeSession,
  restorePlayerRuntimeSessionAt,
  type PlayerRuntimeSession,
  type PlayerRuntimeSessionOptions,
} from "../player/runtime-adapter.js";
import type { CapturedMediaRepository } from "../player/captured-media.js";
import {
  keptSession,
  memoryKeptRoomStore,
  memoryKeptSessionStore,
  type KeptRoomStore,
  type KeptSessionStore,
} from "../player/kept-sessions.js";
import type { DebugRecorder } from "../player/debug-recorder.js";
import type { ScriptStorageProvider } from "../player/script-storage.js";
import type {
  InstructionPlan,
  RuntimeScriptStorageEntrySnapshot,
  SerializableRuntimeValue,
} from "../src/index.js";
import { FakeMediaRepository } from "./helpers/fake-media-repository.js";

// The debug room (DEBUGGER.md "Debug room") through the real Vue session host: Debug on during a normal session goes on
// with a copy in the debug room while the normal session stays as it was; a page opened in the debug room makes it from
// a copy of the script's own saved data and starts with Debug on; Reload session and Reset session start it anew.
interface RoomHost {
  readonly session: Readonly<Ref<PlayerRuntimeSession | null>>;
  readonly activation: Readonly<Ref<"start" | "continue" | null>>;
  readonly notices: Readonly<Ref<readonly { readonly key: string; readonly message: string }[]>>;
  readonly rooms: {
    readonly current: Readonly<Ref<"normal" | "debug">>;
    readonly debugHasData: Readonly<Ref<boolean>>;
    reloadDebug(): Promise<void>;
    resetDebug(): Promise<void>;
  };
  setDebugMode(enabled: boolean): void;
  prepareScript(
    plan: InstructionPlan,
    create: (recording: {
      readonly recorder: DebugRecorder;
      readonly debugMode: boolean;
    }) => PlayerRuntimeSession,
  ): Promise<void>;
  loadScriptStorage(): Promise<void>;
  scriptStorageOptions(): PlayerRuntimeSessionOptions;
  activate(): Promise<void>;
  update(session: PlayerRuntimeSession): void;
}
let usePlayerSession: (options: {
  scriptStorage: ScriptStorageProvider;
  keptSessions: KeptSessionStore;
  debugRooms: KeptRoomStore;
  room?: "normal" | "debug";
  capturedMedia?: { readonly repository: CapturedMediaRepository | null };
}) => RoomHost;
let usePlayerDebug: (
  player: RoomHost,
  initial: { readonly menu: boolean; readonly autoSkip: boolean },
) => { readonly menu: Ref<boolean>; readonly on: Readonly<Ref<boolean>> };

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
    const debug: Record<string, unknown> = await server.ssrLoadModule(
      "/player/vue/src/usePlayerDebug.ts",
    );
    assert.equal(typeof module.usePlayerSession, "function");
    assert.equal(typeof debug.usePlayerDebug, "function");
    // EVIDENCE: validation: Vite loaded the real source modules and the exports are callable; this is their tested API.
    usePlayerSession = module.usePlayerSession as typeof usePlayerSession;
    // EVIDENCE: validation: as above.
    usePlayerDebug = debug.usePlayerDebug as typeof usePlayerDebug;
  } finally {
    await server.close();
  }
});

/** The script's own saved data, in memory. */
function savedData(
  entries: RuntimeScriptStorageEntrySnapshot[],
): ScriptStorageProvider & { entries: RuntimeScriptStorageEntrySnapshot[] } {
  const provider = {
    scope: "test",
    entries,
    load: async () => [...provider.entries],
    write: async (key: string, value: SerializableRuntimeValue) => {
      provider.entries = provider.entries.filter((entry) => entry.key !== key);
      if (value !== null) provider.entries.push({ key, value });
    },
    replace: async (next: readonly RuntimeScriptStorageEntrySnapshot[]) => {
      provider.entries = [...next];
    },
    clear: async () => {
      provider.entries = [];
    },
  };
  return provider;
}

function mountHost(
  context: TestContext,
  options: {
    readonly own: ScriptStorageProvider;
    readonly kept: KeptSessionStore;
    readonly rooms: KeptRoomStore;
    readonly room?: "normal" | "debug";
    readonly repository?: CapturedMediaRepository;
  },
): RoomHost {
  const scope = effectScope();
  const host = scope.run(() =>
    usePlayerSession({
      scriptStorage: options.own,
      keptSessions: options.kept,
      debugRooms: options.rooms,
      ...(options.room === undefined ? {} : { room: options.room }),
      ...(options.repository === undefined
        ? {}
        : { capturedMedia: { repository: options.repository } }),
    }),
  );
  assert.ok(host);
  context.after(() => scope.stop());
  return host;
}

function stubBrowser(context: TestContext) {
  // Event targets are the only browser surface these scripts use; no media elements are created.
  for (const name of ["document", "window"]) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value: new EventTarget() });
    context.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  // The activating click primes audio elements for the session it starts.
  const previousAudio = Object.getOwnPropertyDescriptor(globalThis, "Audio");
  Object.defineProperty(globalThis, "Audio", {
    configurable: true,
    value: class {
      src = "";
      play = () => Promise.resolve();
      pause() {}
      load() {}
      removeAttribute() {}
    },
  });
  context.after(() => {
    if (previousAudio) Object.defineProperty(globalThis, "Audio", previousAudio);
    else Reflect.deleteProperty(globalThis, "Audio");
  });
  context.mock.timers.enable({ apis: ["setTimeout"] });
}

/** Lets storage work and the writes the host issues in later tasks finish. */
async function settle(context: TestContext) {
  for (let round = 0; round < 10; round++) {
    await new Promise((resolve) => setImmediate(resolve));
    context.mock.timers.tick(0);
  }
}

async function prepare(context: TestContext, host: RoomHost, plan: InstructionPlan) {
  await host.loadScriptStorage();
  await host.prepareScript(plan, (recording) =>
    createPlayerRuntimeSession(plan, { ...recording, ...host.scriptStorageOptions() }),
  );
  await settle(context);
}

async function press(context: TestContext, host: RoomHost) {
  const pressed = activatePlayerRuntimeButton(host.session.value!);
  assert.ok(pressed);
  host.update(pressed.session);
  await settle(context);
}

const said = (session: PlayerRuntimeSession | null | undefined) =>
  session?.transcriptEntries.map((entry) => entry.text) ?? [];

const SCRIPT = compilePlayerProject(
  'say "Hello", instant\nshowButton "Next"\nsave debugMode as "on"\nshowButton "Next"\nsave debugMode as "off"\nexit',
).plan!;

test("Debug on during a normal session goes on with a copy in the debug room, and the normal session stays as it was", async (context) => {
  stubBrowser(context);
  const own = savedData([{ key: "best", value: 3 }]);
  const kept = memoryKeptSessionStore();
  const rooms = memoryKeptRoomStore();
  const host = mountHost(context, { own, kept, rooms });
  await prepare(context, host, SCRIPT);
  await host.activate();
  await settle(context);
  assert.equal(host.rooms.current.value, "normal");

  host.setDebugMode(true);
  await settle(context);
  assert.equal(host.rooms.current.value, "debug");
  assert.deepEqual(said(host.session.value), ["Hello"]);
  assert.equal(host.session.value?.state.debugMode, true);
  await press(context, host);
  // The copy's saves are the debug room's; the script's own saved data stay as they were.
  assert.deepEqual(await rooms.values("test").load(), [
    { key: "best", value: 3 },
    { key: "on", value: true },
  ]);
  assert.deepEqual(own.entries, [{ key: "best", value: 3 }]);
  // The normal session is kept where it was, without Debug, for a later visit to continue.
  const normal = keptSession((await kept.session("test"))!)!;
  const restored = restorePlayerRuntimeSessionAt(SCRIPT, normal.snapshotJson, normal.events);
  assert.deepEqual(said(restored), ["Hello"]);
  assert.equal(restored.state.debugMode, false);
});

test("a session kept in an older format shows Start with a notice, and its record stays", async (context) => {
  stubBrowser(context);
  const kept = memoryKeptSessionStore();
  const first = mountHost(context, { own: savedData([]), kept, rooms: memoryKeptRoomStore() });
  await prepare(context, first, SCRIPT);
  await first.activate();
  await settle(context);
  const current = keptSession((await kept.session("test"))!)!;
  const older = (json: string) => {
    const value: { version: number } = JSON.parse(json);
    return JSON.stringify({ ...value, version: value.version - 1 });
  };
  const reopen = async (planJson: string, snapshotJson: string) => {
    await kept.publish("test", {
      planJson,
      snapshotJson,
      eventsFrom: 0,
      events: current.events,
      marks: current.marks,
    });
    const host = mountHost(context, { own: savedData([]), kept, rooms: memoryKeptRoomStore() });
    await prepare(context, host, SCRIPT);
    return host;
  };
  const notice = (host: RoomHost) =>
    host.notices.value
      .filter((entry) => entry.key === "older-kept-session")
      .map((entry) => entry.message);
  const message =
    "The last session comes from an older Player version and cannot be continued. Start begins a new one, and saved progress stays.";
  const plan = current.planJson;
  const snapshot = current.snapshotJson;
  // The current formats continue, without the notice.
  const same = await reopen(plan, snapshot);
  assert.equal(same.activation.value, "continue");
  assert.deepEqual(notice(same), []);
  for (const [planJson, snapshotJson] of [
    [older(plan), snapshot],
    [plan, older(snapshot)],
  ] as const) {
    const host = await reopen(planJson, snapshotJson);
    assert.equal(host.activation.value, "start");
    assert.deepEqual(notice(host), [message]);
    const stored = (await kept.session("test"))!;
    assert.deepEqual([stored.planJson, stored.snapshotJson], [planJson, snapshotJson]);
  }
});

test("while Debug on switches to the debug room, Start waits, and then starts with the debug room's saved data", async (context) => {
  stubBrowser(context);
  const plan = compilePlayerProject(
    'let value = load("value", default: "none")\nsay value, instant\nshowButton "Next"\nexit',
  ).plan!;
  const memory = memoryKeptRoomStore();
  await memory.create("test", [{ key: "value", value: "DEBUG" }], []);
  // The debug room's saved data load slowly, as under storage contention.
  let release = () => {};
  const loaded = new Promise<void>((resolve) => (release = resolve));
  const rooms: KeptRoomStore = {
    ...memory,
    values: (scope) => ({
      ...memory.values(scope),
      load: async () => {
        await loaded;
        return memory.values(scope).load();
      },
    }),
  };
  const host = mountHost(context, {
    own: savedData([{ key: "value", value: "NORMAL" }]),
    kept: memoryKeptSessionStore(),
    rooms,
  });
  await prepare(context, host, plan);
  assert.equal(host.activation.value, "start");

  host.setDebugMode(true);
  assert.equal(host.activation.value, null);
  await host.activate();
  await settle(context);
  assert.equal(host.session.value, null);

  release();
  await settle(context);
  assert.equal(host.rooms.current.value, "debug");
  assert.equal(host.activation.value, "start");
  await host.activate();
  await settle(context);
  assert.deepEqual(said(host.session.value), ["DEBUG"]);
});

test("Debug on during a normal session replaces an earlier debug room with the copy", async (context) => {
  stubBrowser(context);
  const own = savedData([{ key: "best", value: 3 }]);
  const kept = memoryKeptSessionStore();
  const rooms = memoryKeptRoomStore();
  await rooms.create("test", [{ key: "earlier", value: 1 }], []);
  const host = mountHost(context, { own, kept, rooms });
  await prepare(context, host, SCRIPT);
  await host.activate();
  await settle(context);
  host.setDebugMode(true);
  await settle(context);
  assert.deepEqual(await rooms.values("test").load(), [{ key: "best", value: 3 }]);
  assert.deepEqual(said(host.session.value), ["Hello"]);
});

test("a page opened in the debug room makes it from a copy of the script's own saved data and photos", async (context) => {
  stubBrowser(context);
  const reference = "captured-media:00000000-0000-4000-8000-000000000000:1";
  const repository = new FakeMediaRepository();
  const data = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
  await repository.add({
    namespace: "test",
    reference,
    kind: "image",
    mimeType: "image/png",
    size: data.size,
    width: 1,
    height: 1,
    data,
  });
  const own = savedData([{ key: "photo", value: reference }]);
  const rooms = memoryKeptRoomStore();
  const host = mountHost(context, {
    own,
    kept: memoryKeptSessionStore(),
    rooms,
    room: "debug",
    repository,
  });
  await prepare(context, host, SCRIPT);
  assert.equal(host.rooms.current.value, "debug");
  assert.equal(host.activation.value, "start");
  assert.deepEqual(await rooms.values("test").load(), [{ key: "photo", value: reference }]);
  assert.deepEqual(await rooms.media.listReferences("test"), [reference]);
  // Something to delete: the copied saved data.
  assert.equal(host.rooms.debugHasData.value, true);
});

test("a page opened in the debug room starts with Debug on, which the script reads; the normal room starts with it off", async (context) => {
  stubBrowser(context);
  const rooms = memoryKeptRoomStore();
  const host = mountHost(context, {
    own: savedData([]),
    kept: memoryKeptSessionStore(),
    rooms,
    room: "debug",
  });
  // The Player's own Debug feature, which the host starts as it starts without `?dev`.
  const scope = effectScope();
  const debug = scope.run(() => usePlayerDebug(host, { menu: false, autoSkip: false }))!;
  context.after(() => scope.stop());
  assert.equal(debug.menu.value, true);
  assert.equal(debug.on.value, true);
  await prepare(context, host, SCRIPT);
  await host.activate();
  await settle(context);
  await press(context, host);
  // Settings' Debug menu still turns it off.
  debug.menu.value = false;
  await settle(context);
  assert.equal(debug.on.value, false);
  await press(context, host);
  assert.deepEqual(await rooms.values("test").load(), [
    { key: "on", value: true },
    { key: "off", value: false },
  ]);

  const normal = mountHost(context, {
    own: savedData([]),
    kept: memoryKeptSessionStore(),
    rooms: memoryKeptRoomStore(),
  });
  const normalScope = effectScope();
  const normalDebug = normalScope.run(() =>
    usePlayerDebug(normal, { menu: false, autoSkip: false }),
  )!;
  context.after(() => normalScope.stop());
  assert.equal(normalDebug.menu.value, false);
  assert.equal(normal.rooms.current.value, "normal");
});

test("Reload session keeps the debug room's saved data; Reset session deletes them and its photos", async (context) => {
  stubBrowser(context);
  const plan = compilePlayerProject(
    'let runs = load("runs", default: 0) + 1\nsave runs as "runs"\nsay "Run ${runs}", instant\nshowButton "Next"\nexit',
  ).plan!;
  const rooms = memoryKeptRoomStore();
  const host = mountHost(context, {
    own: savedData([]),
    kept: memoryKeptSessionStore(),
    rooms,
    room: "debug",
  });
  await prepare(context, host, plan);
  // A fresh debug room from no saved data has nothing to delete.
  assert.equal(host.rooms.debugHasData.value, false);
  await host.activate();
  await settle(context);
  assert.deepEqual(said(host.session.value), ["Run 1"]);
  assert.equal(host.rooms.debugHasData.value, true);

  await host.rooms.reloadDebug();
  await settle(context);
  assert.deepEqual(said(host.session.value), ["Run 2"]);
  await host.rooms.resetDebug();
  await settle(context);
  assert.deepEqual(said(host.session.value), ["Run 1"]);
  assert.deepEqual(await rooms.values("test").load(), [{ key: "runs", value: 1 }]);
});

test("Debug off in the debug room only stops the script reading Debug as on", async (context) => {
  stubBrowser(context);
  const own = savedData([]);
  const rooms = memoryKeptRoomStore();
  const host = mountHost(context, { own, kept: memoryKeptSessionStore(), rooms });
  await prepare(context, host, SCRIPT);
  await host.activate();
  await settle(context);
  host.setDebugMode(true);
  await settle(context);
  await press(context, host);
  host.setDebugMode(false);
  await settle(context);
  assert.equal(host.rooms.current.value, "debug");
  assert.equal(host.session.value?.state.debugMode, false);
  await press(context, host);
  assert.deepEqual(await rooms.values("test").load(), [
    { key: "on", value: true },
    { key: "off", value: false },
  ]);
  assert.deepEqual(own.entries, []);
});
