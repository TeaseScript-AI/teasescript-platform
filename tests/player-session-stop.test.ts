import assert from "node:assert/strict";
import test, { before, type TestContext } from "node:test";
import { effectScope, nextTick, type Ref } from "vue";
import { createServer } from "vite";

import type { DebugRecorder } from "../player/debug-recorder.js";
import type * as RuntimeAdapter from "../player/runtime-adapter.js";
import type { PlayerRuntimeSession } from "../player/runtime-adapter.js";
import type { ScriptStorageProvider } from "../player/script-storage.js";
import type { SerializableRuntimeValue } from "../src/index.js";

// A Player error stops the session where it stands (PLAYER-UI "Session end and failure"). Input and the work that
// continues it take their session from `observe()`, which gives none once stopped; these include continuations that
// were under way when the error came.
interface StopHost {
  readonly session: Readonly<Ref<PlayerRuntimeSession | null>>;
  readonly hostError: Readonly<Ref<string | null>>;
  readonly stopped: Readonly<Ref<boolean>>;
  readonly permanentButtons: Readonly<Ref<readonly { readonly buttonId: number }[]>>;
  readonly imageCapture: {
    readonly view: Readonly<Ref<{ readonly phase: string } | null>>;
    shutter(): Promise<void>;
    use(): void;
  };
  reportHostError(error: unknown): void;
  observe(): PlayerRuntimeSession | null;
  pressPermanentButton(buttonId: number): Promise<void>;
  editSavedData(edit: {
    readonly key: string;
    readonly value: SerializableRuntimeValue;
    readonly expected: SerializableRuntimeValue | undefined;
  }): Promise<{ readonly kind: string; readonly live?: boolean }>;
  setDebugTracing(on: boolean): void;
  loadScriptStorage(): Promise<void>;
  prepare(create: (options: { readonly recorder: DebugRecorder }) => PlayerRuntimeSession): void;
  activate(): Promise<void>;
  update(session: PlayerRuntimeSession): void;
}
let usePlayerSession: (options: {
  scriptStorage?: ScriptStorageProvider;
  capabilities: { camera: boolean };
}) => StopHost;
let useDebugRewind: (player: StopHost) => {
  back(index: number): Promise<boolean>;
  resume(): Promise<boolean>;
};
let useDevelopmentTime: (
  player: StopHost,
  initial: { readonly autoSkip: boolean },
  log: (text: string) => void,
) => { advanceBy(milliseconds: number): Promise<void> };
// The runtime adapter the composables load, so that the sessions the tests make come from the same module.
let runtime: typeof RuntimeAdapter;

// Load the real Vue composables through the existing build tool: their browser-source imports use Vite resolution.
before(async () => {
  const server = await createServer({
    configFile: false,
    logLevel: "warn",
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true },
  });
  try {
    const session: Record<string, unknown> = await server.ssrLoadModule(
      "/player/vue/src/usePlayerSession.ts",
    );
    const rewind: Record<string, unknown> = await server.ssrLoadModule(
      "/player/vue/src/useDebugRewind.ts",
    );
    const time: Record<string, unknown> = await server.ssrLoadModule(
      "/player/vue/src/useDevelopmentTime.ts",
    );
    const adapter: Record<string, unknown> = await server.ssrLoadModule(
      "/player/runtime-adapter.ts",
    );
    assert.equal(typeof session.usePlayerSession, "function");
    assert.equal(typeof rewind.useDebugRewind, "function");
    assert.equal(typeof time.useDevelopmentTime, "function");
    assert.equal(typeof adapter.createPlayerRuntimeSession, "function");
    // EVIDENCE: validation: Vite loaded the real source modules and each export is callable; these are their host APIs.
    usePlayerSession = session.usePlayerSession as typeof usePlayerSession;
    // EVIDENCE: validation: checked as a function above.
    useDebugRewind = rewind.useDebugRewind as typeof useDebugRewind;
    // EVIDENCE: validation: checked as a function above.
    useDevelopmentTime = time.useDevelopmentTime as typeof useDevelopmentTime;
    // EVIDENCE: validation: the source module the compiled one is built from; checked by one export above.
    runtime = adapter as typeof runtime;
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
class FakeCanvas {
  constructor(
    readonly width = 1,
    readonly height = 1,
  ) {}
  getContext() {
    return {
      drawImage() {},
      getImageData: () => ({ data: new Uint8ClampedArray(this.width * this.height * 4) }),
      putImageData() {},
    };
  }
  async convertToBlob() {
    return new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: "image/png" });
  }
}

// The browser surface the session, its camera, and a photo capture use; the camera opens at once. The error each test
// reports is logged as the Player logs it, which the test does not show.
function stubBrowser(context: TestContext) {
  const document = Object.assign(new EventTarget(), {
    createElement: (kind: string) =>
      kind === "video"
        ? { readyState: 2, videoWidth: 2, videoHeight: 2, play: async () => {}, pause() {} }
        : new FakeCanvas(),
  });
  const values = {
    document,
    window: new EventTarget(),
    navigator: {
      mediaDevices: {
        getUserMedia: async () => {
          const track = new FakeTrack();
          return { getTracks: () => [track] };
        },
      },
    },
    MediaStream: class {
      constructor(readonly tracks: unknown) {}
    },
    HTMLMediaElement: { HAVE_CURRENT_DATA: 2 },
    ImageData: class {
      constructor(
        readonly data: Uint8ClampedArray,
        readonly width: number,
        readonly height: number,
      ) {}
    },
    OffscreenCanvas: FakeCanvas,
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
  context.mock.method(console, "error", () => {});
}

function mount<T>(context: TestContext, create: () => T): T {
  const scope = effectScope();
  const made = scope.run(create);
  assert.ok(made);
  context.after(() => scope.stop());
  return made;
}

const settle = (milliseconds = 50) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const said = (host: StopHost) => host.session.value?.transcriptEntries.map((entry) => entry.text);

test("a Player error stops the session where it stands, and late writes do not continue it", async (context) => {
  stubBrowser(context);
  let finishWrite!: () => void;
  const provider: ScriptStorageProvider = {
    scope: "test",
    load: async () => [],
    write: () => new Promise<void>((resolve) => (finishWrite = resolve)),
    replace: async () => {},
    clear: async () => {},
  };
  const host = mount(context, () =>
    usePlayerSession({ scriptStorage: provider, capabilities: { camera: false } }),
  );
  await host.loadScriptStorage();
  host.prepare(() =>
    runtime.createPlayerRuntimeSession(
      'say "first", instant\nwait 0.1 s\nsave 1 as "count"\nsay "second", instant\nexit',
      { persistentScriptStorage: true },
    ),
  );
  await host.activate();
  assert.deepEqual(said(host), ["first"]);
  host.reportHostError(new TypeError("A component failed."));
  assert.equal(host.hostError.value, "TypeError");
  assert.equal(host.stopped.value, true);
  // The wait ends and its save would be written, but nothing of the stopped session runs, and input takes none.
  await settle(250);
  assert.deepEqual(said(host), ["first"]);
  assert.equal(host.session.value?.state.status, "waiting");
  assert.equal(host.observe(), null);

  // A save written before the stop does not continue the session when it settles.
  host.prepare(() =>
    runtime.createPlayerRuntimeSession('save 1 as "count"\nsay "saved", instant\nexit', {
      persistentScriptStorage: true,
    }),
  );
  await host.activate();
  assert.equal(host.stopped.value, false, "a new Start runs again");
  assert.ok(
    host.session.value && runtime.pendingPlayerRuntimeStorageWrite(host.session.value.state),
  );
  host.reportHostError(new TypeError("A component failed."));
  finishWrite();
  await settle();
  assert.deepEqual(said(host), []);
  assert.ok(
    host.session.value && runtime.pendingPlayerRuntimeStorageWrite(host.session.value.state),
  );
});

test("input admitted just before a Player error does not run after it", async (context) => {
  stubBrowser(context);
  const host = mount(context, () => usePlayerSession({ capabilities: { camera: false } }));
  host.prepare(() =>
    runtime.createPlayerRuntimeSession(
      'showPermanentButton "Help" {\n  say "pressed", instant\n}\nshowButton "Done"\nexit',
    ),
  );
  await host.activate();
  const [button] = host.permanentButtons.value;
  assert.ok(button);
  // The press waits for its input to go ahead, and the error comes meanwhile.
  const pressing = host.pressPermanentButton(button.buttonId);
  host.reportHostError(new TypeError("A component failed."));
  await pressing;
  await settle();
  assert.deepEqual(said(host), []);
});

test("a photo used in the same task as a Player error does not answer", async (context) => {
  stubBrowser(context);
  // The capture's countdown waits a second per step; here it does not wait.
  const setTimer = globalThis.setTimeout;
  context.mock.method(globalThis, "setTimeout", (work: () => void, milliseconds?: number) =>
    setTimer(work, milliseconds === 1000 ? 0 : milliseconds),
  );
  const host = mount(context, () => usePlayerSession({ capabilities: { camera: false } }));
  host.prepare(({ recorder }) =>
    runtime.createPlayerRuntimeSession(
      'let photo = askImage("Photo")\nsay "after photo", instant\nshowButton "Done"\nexit',
      { recorder },
    ),
  );
  await host.activate();
  await settle();
  assert.equal(host.imageCapture.view.value?.phase, "live");
  await host.imageCapture.shutter();
  assert.equal(host.imageCapture.view.value?.phase, "review");
  host.reportHostError(new TypeError("A component failed."));
  const stopped = host.session.value;
  host.imageCapture.use();
  await nextTick();
  assert.equal(host.session.value, stopped);
  assert.deepEqual(said(host), ["Photo"]);
});

test("a jump waiting for a save ends when a Player error stops the session", async (context) => {
  stubBrowser(context);
  let finishSave!: () => void;
  const provider: ScriptStorageProvider = {
    scope: "test",
    load: async () => [],
    write: () => new Promise<void>((resolve) => (finishSave = resolve)),
    replace: async () => {},
    clear: async () => {},
  };
  const host = mount(context, () =>
    usePlayerSession({ scriptStorage: provider, capabilities: { camera: false } }),
  );
  const time = mount(context, () => useDevelopmentTime(host, { autoSkip: false }, () => {}));
  await host.loadScriptStorage();
  host.prepare(() =>
    runtime.createPlayerRuntimeSession(
      'wait 5 s\nsave 1 as "count"\nsay "after save", instant\nshowButton "Done"\nexit',
      { persistentScriptStorage: true },
    ),
  );
  await host.activate();
  let ended = false;
  const jumping = time.advanceBy(10_000).then(() => (ended = true));
  await settle();
  assert.equal(typeof finishSave, "function");
  assert.equal(ended, false, "the jump waits for the save");
  host.reportHostError(new TypeError("A component failed."));
  await settle();
  assert.equal(ended, true);
  await jumping;
  finishSave();
  await settle();
  assert.deepEqual(said(host), []);
  assert.equal(host.session.value?.state.observedSessionTimeMs, 5000);
});

test("Resume after a Player error is refused before the saved data are replaced", async (context) => {
  stubBrowser(context);
  const values = new Map<string, SerializableRuntimeValue>();
  const replacements: unknown[] = [];
  const provider: ScriptStorageProvider = {
    scope: "test",
    load: async () => [...values].map(([key, value]) => ({ key, value })),
    write: async (key, value) => void values.set(key, value),
    replace: async (entries) => {
      replacements.push(entries);
      values.clear();
      for (const { key, value } of entries) values.set(key, value);
    },
    clear: async () => values.clear(),
  };
  const host = mount(context, () =>
    usePlayerSession({ scriptStorage: provider, capabilities: { camera: false } }),
  );
  const rewind = mount(context, () => useDebugRewind(host));
  await host.loadScriptStorage();
  host.prepare(({ recorder }) =>
    runtime.createPlayerRuntimeSession(
      'showButton "First"\nsave 1 as "count"\nshowButton "Second"\nexit',
      { recorder, persistentScriptStorage: true },
    ),
  );
  await host.activate();
  await nextTick();
  const first = host.session.value && runtime.activatePlayerRuntimeButton(host.session.value);
  assert.ok(first);
  host.update(first.session);
  await settle();
  assert.equal(values.get("count"), 1);
  assert.equal(await rewind.back(0), true);
  host.reportHostError(new TypeError("A component failed."));
  assert.equal(await rewind.resume(), false);
  assert.deepEqual(replacements, []);
  assert.equal(values.get("count"), 1);
});

test("after a Player error, a Debug edit does not wait for the dropped save, which is not issued again", async (context) => {
  stubBrowser(context);
  const stored = new Map<string, SerializableRuntimeValue>();
  const writes: [string, SerializableRuntimeValue][] = [];
  let finishScriptSave!: () => void;
  const provider: ScriptStorageProvider = {
    scope: "test",
    load: async () => [...stored].map(([key, value]) => ({ key, value })),
    write: (key, value) => {
      writes.push([key, value]);
      const store = () => void stored.set(key, value);
      // The script's own save settles only when the test says so; the edit's at once.
      if (writes.length > 1) return Promise.resolve(store());
      return new Promise<void>((resolve) => (finishScriptSave = () => resolve(store())));
    },
    replace: async () => {},
    clear: async () => {},
  };
  const host = mount(context, () =>
    usePlayerSession({ scriptStorage: provider, capabilities: { camera: false } }),
  );
  await host.loadScriptStorage();
  host.prepare(() =>
    runtime.createPlayerRuntimeSession('save 1 as "count"\nsay "after save", instant\nexit', {
      persistentScriptStorage: true,
    }),
  );
  await host.activate();
  assert.deepEqual(writes, [["count", 1]]);
  host.reportHostError(new TypeError("A component failed."));
  finishScriptSave();
  await settle();
  assert.deepEqual(await host.editSavedData({ key: "count", value: 42, expected: 1 }), {
    kind: "saved",
    live: false,
  });
  // Publishing the stopped session again, as Debug's value trace does, issues no write.
  host.setDebugTracing(true);
  await settle();
  assert.deepEqual(writes, [
    ["count", 1],
    ["count", 42],
  ]);
  assert.equal(stored.get("count"), 42);
});
