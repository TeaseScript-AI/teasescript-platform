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
  showViewfinder(shown: boolean): void;
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
    clear: async () => entries.clear(),
  };
  const pending = createPlayerRuntimeSession('save 1 as "first"\nexit', {
    scriptStorage: [{ key: "first", value: 0 }],
    persistentScriptStorage: true,
  });
  assert.ok(pendingPlayerRuntimeStorageWrite(pending.snapshot));
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
  const status = () => host.session.value?.snapshot.status;
  assert.ok(status());
  const deadline = Date.now() + 2_000;
  while (status() !== "halted") {
    assert.ok(Date.now() < deadline, "the restored write was not serviced");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.deepEqual([...entries], [["first", 1]]);
  assert.equal(host.canClearScriptStorage.value, true);
});

test("the viewfinder previews the session camera only while shown, and a new session starts without it", async (context) => {
  const { grant, tracks } = stubBrowser(context);
  grant();
  const host = mount(context, { capabilities: { camera: true } });
  const script = () => createPlayerRuntimeSession('showButton "Take photo"\nexit');
  // Without an open camera there is nothing to preview.
  host.showViewfinder(true);
  assert.equal(host.viewfinder.value, null);

  host.prepare(script);
  await host.activate();
  const [camera] = tracks;
  assert.ok(camera);
  assert.equal(host.viewfinder.value, null);
  host.showViewfinder(true);
  assert.equal(host.viewfinder.value, camera);
  // Hiding the preview keeps the camera open for `takePhoto()`.
  host.showViewfinder(false);
  assert.equal(host.viewfinder.value, null);
  assert.equal(camera.readyState, "live");

  // An ended camera has nothing to preview.
  host.showViewfinder(true);
  camera.dispatchEvent(new Event("ended"));
  assert.equal(host.viewfinder.value, null);

  host.prepare(script);
  await host.activate();
  assert.equal(tracks.length, 2);
  assert.equal(host.viewfinder.value, null);
  host.showViewfinder(true);
  assert.equal(host.viewfinder.value, tracks[1]);
});
