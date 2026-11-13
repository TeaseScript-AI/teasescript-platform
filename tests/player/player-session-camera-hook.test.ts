import assert from "node:assert/strict";
import { before, type TestContext } from "node:test";
import { effectScope, type Ref } from "vue";

import { playerRuntimeSnapshot } from "../../player/runtime/runtime-adapter.js";
import { createPlayerRuntimeSession } from "../../player/runtime/compile-project.js";
import {
  pendingPlayerRuntimeStorageWrite,
  type PlayerSession,
} from "../../player/runtime/runtime-view.js";
import type { ScriptStorageProvider } from "../../player/persistence/script-storage.js";
import type { SerializableRuntimeValue } from "../../src/index.js";
import { FakeMediaRepository } from "../helpers/player/fake-media-repository.js";
import { loadPlayerModule } from "../helpers/player-modules.js";
import {
  preparedPlan,
  preparedSource,
  sourceStart,
  type PlanStart,
} from "../helpers/prepared-plan.js";
import {
  checkpointSnapshot,
  loadTopology,
  rerunRegistry,
  restoredSession,
  TOPOLOGIES,
  topologyBridge,
  type TopologyBridge,
} from "../helpers/player/worker-topology.js";
import type { PlayerBridge } from "../../player/runtime/player-bridge.js";

// Load the real Vue composable through the existing build tool: its browser-source imports use Vite resolution.
interface CameraHost {
  readonly bridge: Promise<PlayerBridge>;
  readonly session: Readonly<Ref<PlayerSession | null>>;
  readonly canClearScriptStorage: Readonly<Ref<boolean>>;
  readonly viewfinder: Readonly<Ref<FakeTrack | null>>;
  readonly viewfinderPlacement: Readonly<Ref<"window" | "stage" | null>>;
  readonly hostError: Readonly<Ref<string | null>>;
  loadScriptStorage(): Promise<void>;
  clearScriptStorage(): Promise<boolean>;
  prepare(create: PlanStart): void;
  prepareRestore(restored: PlayerSession): void;
  activate(): Promise<void>;
}
let usePlayerSession: (options: {
  scriptStorage?: ScriptStorageProvider;
  capabilities: { camera: boolean };
  capturedMedia?: { repository: FakeMediaRepository };
  bridge?: Promise<PlayerBridge>;
}) => CameraHost;

before(async () => {
  await loadTopology();
  const module: Record<string, unknown> = await loadPlayerModule(
    "player/vue/src/session/usePlayerSession.ts",
  );
  assert.equal(typeof module.usePlayerSession, "function");
  // EVIDENCE: validation: Vite loaded the real source module and the export is callable; this is its tested host API.
  usePlayerSession = module.usePlayerSession as typeof usePlayerSession;
});

class FakeTrack extends EventTarget {
  readonly kind = "video";
  readonly label = "fake camera";
  readyState: "live" | "ended" = "live";
  stop() {
    this.readyState = "ended";
  }
  getSettings() {
    return { deviceId: "fake camera" };
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
      mediaDevices: Object.assign(new EventTarget(), {
        getUserMedia: async () => {
          await granted;
          const track = new FakeTrack();
          tracks.push(track);
          return { getTracks: () => [track] };
        },
      }),
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

/** The real composable on `transport`'s bridge. */
function mount(
  context: TestContext,
  transport: TopologyBridge,
  options: Parameters<typeof usePlayerSession>[0],
): CameraHost {
  const scope = effectScope();
  const host = scope.run(() =>
    usePlayerSession({ ...options, bridge: Promise.resolve(transport.bridge) }),
  );
  assert.ok(host);
  context.after(() => scope.stop());
  return host;
}

/*
 * Every row runs on a Worker (L5i.7); a restore goes through the Worker test entry's `restoreForTest`.
 * The file's end checks every registered row ran.
 */
const RERUN = rerunRegistry({
  "clearing while a restored session waits": TOPOLOGIES,
  "camera view": TOPOLOGIES,
  "Start that throws": TOPOLOGIES,
});

RERUN.rows(
  "clearing while a restored session waits",
  "saved data cannot be cleared while a restored session waits for the camera",
  async (context, topology, end) => {
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
    const transport = await topologyBridge(context, topology, { entry: "restore" });
    const host = mount(context, transport, {
      scriptStorage: provider,
      capabilities: { camera: true },
      capturedMedia: { repository: new FakeMediaRepository() },
    });
    await host.loadScriptStorage();
    transport.assertTopology();
    host.prepareRestore(
      await restoredSession(
        transport,
        await preparedPlan(host.bridge, pending.plan),
        JSON.stringify(playerRuntimeSnapshot(pending)),
      ),
    );

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
    return end();
  },
);

RERUN.rows(
  "camera view",
  "the script's camera view previews the session camera where it places it, also after a restore",
  async (context, topology, end) => {
    const { grant, tracks } = stubBrowser(context);
    grant();
    const transport = await topologyBridge(context, topology, { entry: "restore" });
    const host = mount(context, transport, { capabilities: { camera: true } });
    await host.bridge;
    transport.assertTopology();
    const shown = 'let view = showCamera stage\nshowButton "Hide"\nexit';
    host.prepare(await sourceStart(host.bridge, shown));
    await host.activate();
    const [camera] = tracks;
    assert.ok(camera);
    assert.equal(host.viewfinderPlacement.value, "stage");
    assert.equal(host.viewfinder.value, camera);
    const showing = host.session.value;
    assert.ok(showing);
    // The state to restore later, read from the host over the bridge.
    const saved = JSON.stringify(await checkpointSnapshot(await host.bridge, showing));
    // A camera the browser or the system ended opens again: the view keeps its picture until the reopened camera's
    // arrives, and the script's placement stays.
    camera.dispatchEvent(new Event("ended"));
    assert.equal(host.viewfinder.value, camera);
    const deadline = Date.now() + 2_000;
    while (host.viewfinder.value === camera) {
      assert.ok(Date.now() < deadline, "the ended camera did not open again");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(host.viewfinder.value, tracks[1]);
    assert.equal(host.viewfinderPlacement.value, "stage");

    // Hiding the view keeps the camera open for `takePhoto()`.
    host.prepare(await sourceStart(host.bridge, 'showCamera\nhideCamera\nshowButton "Done"\nexit'));
    await host.activate();
    assert.equal(host.viewfinderPlacement.value, null);
    assert.equal(host.viewfinder.value, null);
    assert.equal(tracks[2]?.readyState, "live");

    // A restored session shows the view where it was, with the camera Continue opens.
    host.prepareRestore(await restoredSession(transport, showing.planToken, saved));
    await host.activate();
    assert.equal(host.viewfinderPlacement.value, "stage");
    assert.equal(host.viewfinder.value, tracks[3]);
    return end();
  },
);

RERUN.rows(
  "Start that throws",
  "a Start that throws after the camera opened releases the camera",
  async (context, topology, end) => {
    const { grant, tracks } = stubBrowser(context);
    context.mock.method(console, "error", () => {});
    grant();
    const transport = await topologyBridge(context, topology);
    const host = mount(context, transport, { capabilities: { camera: true } });
    await host.bridge;
    transport.assertTopology();
    // Its options are read as it begins, after the camera opened: a throw there is the Start's.
    host.prepare({
      plan: await preparedSource(host.bridge, "exit"),
      options: () => {
        throw new TypeError("The script could not start.");
      },
    });
    await host.activate();
    assert.equal(host.hostError.value, "TypeError");
    assert.equal(tracks.length, 1);
    assert.equal(tracks[0]?.readyState, "ended");
    return end();
  },
);
