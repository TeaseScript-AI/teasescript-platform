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
interface CameraStorageHost {
  readonly session: Readonly<Ref<PlayerRuntimeSession | null>>;
  readonly canClearScriptStorage: Readonly<Ref<boolean>>;
  loadScriptStorage(): Promise<void>;
  clearScriptStorage(): Promise<boolean>;
  prepareRestore(restored: PlayerRuntimeSession): void;
  activate(): Promise<void>;
}
let usePlayerSession: (options: {
  scriptStorage: ScriptStorageProvider;
  capabilities: { camera: boolean };
  capturedMedia: { repository: FakeMediaRepository };
}) => CameraStorageHost;

before(async () => {
  const server = await createServer({
    configFile: false,
    logLevel: "warn",
    server: { middlewareMode: true },
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

// The browser surface the session camera and audio priming use; getUserMedia answers when the test grants it.
function stubBrowser(context: TestContext) {
  let grant!: () => void;
  const granted = new Promise<void>((resolve) => (grant = resolve));
  const values = {
    document: new EventTarget(),
    window: new EventTarget(),
    navigator: {
      mediaDevices: {
        getUserMedia: async () => {
          await granted;
          return { getTracks: () => [new FakeTrack()] };
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
  return grant;
}

test("saved data cannot be cleared while a restored session waits for the camera", async (context) => {
  const grant = stubBrowser(context);
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
  const scope = effectScope();
  const host = scope.run(() =>
    usePlayerSession({
      scriptStorage: provider,
      capabilities: { camera: true },
      capturedMedia: { repository: new FakeMediaRepository() },
    }),
  );
  assert.ok(host);
  context.after(() => scope.stop());
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
