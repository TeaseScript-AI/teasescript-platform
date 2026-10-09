import assert from "node:assert/strict";
import test, { before, type TestContext } from "node:test";
import { effectScope, type Ref } from "vue";
import { createServer } from "vite";

import {
  createPlayerRuntimeRestorePoint,
  createPlayerRuntimeSession,
  pendingPlayerRuntimeStorageWrite,
  restorePlayerRuntimeSession,
  type PlayerRuntimeSession,
} from "../player/runtime-adapter.js";
import type { ScriptStorageProvider } from "../player/script-storage.js";
import type { SerializableRuntimeValue } from "../src/index.js";
import { FakeMediaRepository } from "./helpers/fake-media-repository.js";

// Load the real Vue composable through the existing build tool: its browser-source imports use Vite resolution.
interface CameraHost {
  readonly session: Readonly<Ref<PlayerRuntimeSession | null>>;
  readonly canClearScriptStorage: Readonly<Ref<boolean>>;
  readonly viewfinder: Readonly<Ref<FakeTrack | null>>;
  readonly viewfinderPlacement: Readonly<Ref<"window" | "stage" | null>>;
  readonly hostError: Readonly<Ref<string | null>>;
  readonly stopped: Readonly<Ref<boolean>>;
  reportHostError(error: unknown): void;
  prepareInput(): true | Promise<boolean>;
  loadScriptStorage(): Promise<void>;
  clearScriptStorage(): Promise<boolean>;
  prepare(create: () => PlayerRuntimeSession): void;
  prepareRestore(restored: PlayerRuntimeSession): void;
  activate(): Promise<void>;
}
let usePlayerSession: (options: {
  scriptStorage?: ScriptStorageProvider;
  capabilities: { camera: boolean };
  capturedMedia?: { repository: FakeMediaRepository };
}) => CameraHost;

before(async () => {
  const server = await createServer({
    configFile: false,
    logLevel: "warn",
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

class FakeTrack extends EventTarget {
  readonly kind = "video";
  readonly label = "fake camera";
  readyState: "live" | "ended" = "live";
  stop() {
    this.readyState = "ended";
  }
}

// The browser surface the session camera and audio priming use; getUserMedia answers when the test grants it, with a
// new camera track each time.
function stubBrowser(context: TestContext) {
  let grant!: () => void;
  const granted = new Promise<void>((resolve) => (grant = resolve));
  const tracks: FakeTrack[] = [];
  const values = {
    document: new EventTarget(),
    window: new EventTarget(),
    navigator: {
      mediaDevices: {
        getUserMedia: async () => {
          await granted;
          const track = new FakeTrack();
          tracks.push(track);
          return { getTracks: () => [track] };
        },
      },
    },
    Audio: class {
      src = "";
      play = async () => {};
      pause() {}
      load() {}
      removeAttribute() {}
    },
  };
  for (const [name, value] of Object.entries(values)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    context.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  return { grant, tracks };
}

function mount(context: TestContext, options: Parameters<typeof usePlayerSession>[0]): CameraHost {
  const scope = effectScope();
  const host = scope.run(() => usePlayerSession(options));
  assert.ok(host);
  context.after(() => scope.stop());
  return host;
}

test("saved data cannot be cleared while a restored session waits for the camera", async (context) => {
  const { grant } = stubBrowser(context);
  const entries = new Map<string, SerializableRuntimeValue>([["first", 0]]);
  const provider: ScriptStorageProvider = {
    scope: "test",
    load: async () => [...entries].map(([key, value]) => ({ key, value })),
    write: async (key, value) =>
      void (value === null ? entries.delete(key) : entries.set(key, value)),
    replace: async (next) => {
      entries.clear();
      for (const { key, value } of next) entries.set(key, value);
    },
    clear: async () => entries.clear(),
  };
  const pending = createPlayerRuntimeSession('save 1 as "first"\nexit', {
    scriptStorage: [{ key: "first", value: 0 }],
    persistentScriptStorage: true,
  });
  assert.ok(pendingPlayerRuntimeStorageWrite(pending.state));
  const host = mount(context, {
    scriptStorage: provider,
    capabilities: { camera: true },
    capturedMedia: { repository: new FakeMediaRepository() },
  });
  await host.loadScriptStorage();
  host.prepareRestore(restorePlayerRuntimeSession(createPlayerRuntimeRestorePoint(pending)));

  const activation = host.activate();
  assert.equal(host.session.value, null);
  assert.equal(host.canClearScriptStorage.value, false);
  assert.equal(await host.clearScriptStorage(), false);
  assert.deepEqual([...entries], [["first", 0]]);

  grant();
  await activation;
  const status = () => host.session.value?.state.status;
  assert.ok(status());
  const deadline = Date.now() + 2_000;
  while (status() !== "halted") {
    assert.ok(Date.now() < deadline, "the restored write was not serviced");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.deepEqual([...entries], [["first", 1]]);
  assert.equal(host.canClearScriptStorage.value, true);
});

test("the script's camera view previews the session camera where it places it, also after a restore", async (context) => {
  const { grant, tracks } = stubBrowser(context);
  grant();
  const host = mount(context, { capabilities: { camera: true } });
  const shown = 'let view = showCamera stage\nshowButton "Hide"\nexit';
  host.prepare(() => createPlayerRuntimeSession(shown));
  await host.activate();
  const [camera] = tracks;
  assert.ok(camera);
  assert.equal(host.viewfinderPlacement.value, "stage");
  assert.equal(host.viewfinder.value, camera);
  const showing = host.session.value;
  assert.ok(showing);
  const saved = createPlayerRuntimeRestorePoint(showing);
  // An ended camera has nothing to preview; the script's placement stays.
  camera.dispatchEvent(new Event("ended"));
  assert.equal(host.viewfinder.value, null);
  assert.equal(host.viewfinderPlacement.value, "stage");

  // Hiding the view keeps the camera open for `takePhoto()`.
  host.prepare(() => createPlayerRuntimeSession('showCamera\nhideCamera\nshowButton "Done"\nexit'));
  await host.activate();
  assert.equal(host.viewfinderPlacement.value, null);
  assert.equal(host.viewfinder.value, null);
  assert.equal(tracks[1]?.readyState, "live");

  // A restored session shows the view where it was, with the camera Continue opens.
  host.prepareRestore(restorePlayerRuntimeSession(saved));
  await host.activate();
  assert.equal(host.viewfinderPlacement.value, "stage");
  assert.equal(host.viewfinder.value, tracks[2]);
});

test("a Player exception stops the session where it stands, and late writes do not continue it", async (context) => {
  stubBrowser(context);
  context.mock.method(console, "error", () => {});
  let finishWrite!: () => void;
  const provider: ScriptStorageProvider = {
    scope: "test",
    load: async () => [],
    write: () => new Promise<void>((resolve) => (finishWrite = resolve)),
    replace: async () => {},
    clear: async () => {},
  };
  const host = mount(context, { scriptStorage: provider, capabilities: { camera: false } });
  await host.loadScriptStorage();
  host.prepare(() =>
    createPlayerRuntimeSession(
      'say "first", instant\nwait 0.1 s\nsave 1 as "count"\nsay "second", instant\nexit',
      { persistentScriptStorage: true },
    ),
  );
  await host.activate();
  const said = () => host.session.value?.transcriptEntries.map((entry) => entry.text);
  assert.deepEqual(said(), ["first"]);
  host.reportHostError(new TypeError("A component failed."));
  assert.equal(host.hostError.value, "TypeError");
  assert.equal(host.stopped.value, true);
  // The wait ends and its save would be written, but nothing of the stopped session runs.
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.deepEqual(said(), ["first"]);
  assert.equal(host.session.value?.state.status, "waiting");
  assert.equal(await host.prepareInput(), false);

  // A save written before the stop does not continue the session when it settles.
  host.prepare(() =>
    createPlayerRuntimeSession('save 1 as "count"\nsay "saved", instant\nexit', {
      persistentScriptStorage: true,
    }),
  );
  await host.activate();
  assert.equal(host.stopped.value, false, "a new Start runs again");
  assert.ok(host.session.value && pendingPlayerRuntimeStorageWrite(host.session.value.state));
  host.reportHostError(new TypeError("A component failed."));
  finishWrite();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(said(), []);
  assert.ok(host.session.value && pendingPlayerRuntimeStorageWrite(host.session.value.state));
});

test("a Start that throws after the camera opened releases the camera", async (context) => {
  const { grant, tracks } = stubBrowser(context);
  context.mock.method(console, "error", () => {});
  grant();
  const host = mount(context, { capabilities: { camera: true } });
  host.prepare(() => {
    throw new TypeError("The script could not start.");
  });
  await host.activate();
  assert.equal(host.hostError.value, "TypeError");
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0]?.readyState, "ended");
});
