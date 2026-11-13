import assert from "node:assert/strict";
import test, { before, type TestContext } from "node:test";
import { effectScope, nextTick, watch, type Ref } from "vue";

import {
  assembleDebugExport,
  chooseDebugCategory,
  chooseDebugPhoto,
  NO_PERSONAL_CONTENT,
  type DebugExportCandidate,
} from "../../player/debug/debug-export-assembly.js";
import {
  debugExportFile,
  parseDebugExport,
  replayDebugExport,
} from "../../player/debug/debug-export.js";
import type { DebugRecording } from "../../player/debug/debug-recorder.js";
import type * as CompileProject from "../../player/runtime/compile-project.js";
import type * as InProcess from "../helpers/bridge/in-process.js";
import type * as RuntimeAdapter from "../../player/runtime/runtime-adapter.js";
import type * as RuntimeView from "../../player/runtime/runtime-view.js";
import type { PlayerRuntimeSession } from "../../player/runtime/runtime-adapter.js";
import type { ScriptStorageProvider } from "../../player/persistence/script-storage.js";
import type { SerializableRuntimeValue } from "../../src/index.js";
import { FakeMediaRepository } from "../helpers/player/media/fake-media-repository.js";
import { published } from "../helpers/debug-readers.js";
import { loadPlayerModule } from "../helpers/player-modules.js";
import { answerWith, type Intent } from "../helpers/player/player-input.js";
import { loadHostFacade, onHostAll } from "../helpers/player/host-sessions.js";
import { sourceStart, type PlanStart } from "../helpers/prepared-plan.js";
import type { PlayerBridge } from "../../player/runtime/player-bridge.js";
import { inProcessBackend } from "../helpers/player/worker-topology.js";

// A Player error stops the session where it stands (PLAYER-UI "Session end and failure"). Input and the work that
// continues it take their session from `observe()`, which gives none once stopped; these include continuations that
// were under way when the error came.
interface StopHost {
  readonly bridge: Promise<PlayerBridge>;
  readonly session: Readonly<Ref<PlayerRuntimeSession | null>>;
  readonly hostError: Readonly<Ref<string | null>>;
  readonly stopped: Readonly<Ref<boolean>>;
  readonly permanentButtons: Readonly<Ref<readonly { readonly buttonId: number }[]>>;
  readonly imageCapture: {
    readonly view: Readonly<Ref<{ readonly phase: string; readonly ready: boolean } | null>>;
    openCamera(): void;
    takePhoto(): Promise<void>;
    answer(input: "button"): Intent;
  };
  reportHostError(error: unknown): void;
  observe(): Promise<PlayerRuntimeSession | null>;
  demandCallView(): { release(): void };
  pressPermanentButton(buttonId: number): Promise<void>;
  editSavedData(edit: {
    readonly key: string;
    readonly value: SerializableRuntimeValue;
    readonly expected: SerializableRuntimeValue | undefined;
  }): Promise<{ readonly kind: string; readonly live?: boolean }>;
  setDebugTracing(on: boolean): void;
  debugRecording(): Promise<DebugRecording | null>;
  debugExportCandidate(
    details: () => Pick<DebugExportCandidate, "player" | "host">,
    wanted: AbortSignal,
  ): Promise<DebugExportCandidate>;
  loadScriptStorage(): Promise<void>;
  scriptStorageOptions(): RuntimeAdapter.PlayerRuntimeSessionOptions;
  prepare(create: PlanStart): void;
  activate(): Promise<void>;
  update(session: PlayerRuntimeSession): void;
  resolveAsset(path: string): string | null;
  setRandomControl(control: { readonly sites: readonly [] } | null): void;
  resolveRandomDraw(drawId: number, outcome: "natural"): Promise<{ readonly kind: string } | null>;
  readonly inputSection: unknown;
}
let usePlayerSession: (options: {
  readonly bridge: Promise<PlayerBridge>;
  scriptStorage?: ScriptStorageProvider;
  capturedMedia?: { repository: FakeMediaRepository };
  capabilities: { camera: boolean };
}) => StopHost;
interface StopRewind {
  readonly state: Readonly<Ref<{ readonly points: readonly { readonly id: number }[] }>>;
  back(point: number): Promise<boolean>;
  resume(): Promise<boolean>;
  returnToSession(): Promise<boolean>;
}
let useDebugRewind: (player: StopHost) => StopRewind;
/** Back to the point at `index` in the history's points, by its ID. */
const backTo = (rewind: StopRewind, index: number) =>
  rewind.back(rewind.state.value.points[index]?.id ?? -1);
let useDevelopmentTime: (
  player: StopHost,
  initial: { readonly autoSkip: boolean },
  log: (text: string) => void,
) => { advanceBy(milliseconds: number): Promise<void> };
// The runtime adapter the composables load, so that the sessions the tests make come from the same module.
// The adapter with the compiler's source Start (`compile-project.ts`), from the modules the composables load.
let runtime: typeof RuntimeAdapter & typeof CompileProject;
let view: typeof RuntimeView;

// Load the real Vue composables through the existing build tool: their browser-source imports use Vite resolution.
before(async () => {
  await loadHostFacade();
  const session: Record<string, unknown> = await loadPlayerModule(
    "player/vue/src/session/usePlayerSession.ts",
  );
  const rewind: Record<string, unknown> = await loadPlayerModule(
    "player/vue/src/debug/history/useDebugRewind.ts",
  );
  const time: Record<string, unknown> = await loadPlayerModule(
    "player/vue/src/debug/useDevelopmentTime.ts",
  );
  const adapter = {
    ...(await loadPlayerModule("player/runtime/runtime-adapter.ts")),
    ...(await loadPlayerModule("player/runtime/compile-project.ts")),
  };
  const viewModule: Record<string, unknown> = await loadPlayerModule(
    "player/runtime/runtime-view.ts",
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
  runtime = onHostAll(adapter) as typeof runtime;
  assert.equal(typeof viewModule.playerRuntimeForeground, "function");
  // EVIDENCE: validation: the source module the compiled one is built from; checked by one export above.
  view = viewModule as typeof view;
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
    encoding.started++;
    await encoding.held;
    return new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: "image/png" });
  }
}
/** The photos being encoded: how many started, and what the next ones wait for (`holdEncoding`). */
const encoding: { started: number; held: Promise<void> | null } = { started: 0, held: null };
/** Holds every photo's encoding until the returned function is called. */
function holdEncoding(): () => void {
  let release!: () => void;
  encoding.held = new Promise((resolve) => (release = resolve));
  return () => {
    encoding.held = null;
    release();
  };
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
      mediaDevices: Object.assign(new EventTarget(), {
        getUserMedia: async () => {
          const track = new FakeTrack();
          return { getTracks: () => [track] };
        },
      }),
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
// What only the Player's interface adds to a debug export candidate, here nothing of note.
const shown: Pick<DebugExportCandidate, "player" | "host"> = {
  player: {},
  host: { stage: { status: "hidden", path: null }, media: [], notices: [], debugLog: null },
};
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
    usePlayerSession({
      bridge: inProcessBackend(),
      scriptStorage: provider,
      capabilities: { camera: false },
    }),
  );
  await host.loadScriptStorage();
  host.prepare(
    await sourceStart(
      host.bridge,
      'say "first", instant\nwait 0.1 s\nsave 1 as "count"\nsay "second", instant\nexit',
      () => ({ persistentScriptStorage: true }),
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
  assert.equal(await host.observe(), null);

  // A save written before the stop does not continue the session when it settles.
  host.prepare(
    await sourceStart(host.bridge, 'save 1 as "count"\nsay "saved", instant\nexit', () => ({
      persistentScriptStorage: true,
    })),
  );
  await host.activate();
  assert.equal(host.stopped.value, false, "a new Start runs again");
  assert.ok(host.session.value && view.pendingPlayerRuntimeStorageWrite(host.session.value.state));
  host.reportHostError(new TypeError("A component failed."));
  finishWrite();
  await settle();
  assert.deepEqual(said(host), []);
  assert.ok(host.session.value && view.pendingPlayerRuntimeStorageWrite(host.session.value.state));
});

test("a session a Player error stopped shows its calls without a demand, which asks the stopped session nothing", async (context) => {
  stubBrowser(context);
  const host = mount(context, () =>
    usePlayerSession({
      bridge: inProcessBackend(),
      scriptStorage: {
        scope: "test",
        load: async () => [],
        write: async () => {},
        replace: async () => {},
        clear: async () => {},
      },
      capabilities: { camera: false },
    }),
  );
  await host.loadScriptStorage();
  host.prepare(
    await sourceStart(
      host.bridge,
      'function inner {\n  wait 5 s\n}\ninner()\nsay "after", instant\nexit',
    ),
  );
  await host.activate();
  const shown = () => published(host.session.value);
  assert.equal(shown().callView, null, "nothing asked for the calls");
  const bridge = shown().connection;
  let asked = 0;
  const viewCalls = bridge.viewCalls.bind(bridge);
  bridge.viewCalls = (session, on) => {
    asked += 1;
    return viewCalls(session, on);
  };
  const before = shown();
  host.reportHostError(new TypeError("A component failed."));
  await settle();
  // The stop's acknowledgement froze the session with its calls; what it shows is unchanged.
  const stopped = shown();
  assert.equal(stopped.revision, before.revision);
  assert.deepEqual(stopped.state, before.state);
  assert.deepEqual(
    view.playerRuntimeCalls(stopped)?.map((call) => call.name),
    ["inner"],
  );
  // Debug's Now view, opened only now, asks the stopped session for nothing.
  const demand = host.demandCallView();
  await settle();
  demand.release();
  await settle();
  assert.equal(asked, 0);
});

test("a save that settles while the stop waits for its acknowledgement is not issued again when the stop shows", async (context) => {
  stubBrowser(context);
  const module = await loadPlayerModule("tests/helpers/bridge/in-process.ts");
  // EVIDENCE: validation: Vite loaded the real source module; this is its backend factory.
  const make = module["createInProcessBackend"] as typeof InProcess.createInProcessBackend;
  const bridge = make(
    { commit: null, dirty: null, mode: null, appVersion: null },
    { delayMs: 200 },
  );
  context.after(() => bridge.client.terminate());
  let finishWrite!: () => void;
  let writes = 0;
  const options = {
    bridge: Promise.resolve(bridge),
    capabilities: { camera: false },
    scriptStorage: {
      scope: "review",
      load: async () => [],
      replace: async () => {},
      clear: async () => {},
      write: () => {
        writes += 1;
        return new Promise<void>((resolve) => {
          finishWrite = resolve;
        });
      },
    },
  };
  const host = mount(context, () => usePlayerSession(options));
  await host.loadScriptStorage();
  host.prepare(
    await sourceStart(host.bridge, 'save 1 as "count"\nsay "after", instant\nexit', () => ({
      persistentScriptStorage: true,
    })),
  );
  await host.activate();
  assert.equal(writes, 1);
  const before = published(host.session.value);
  host.reportHostError(new TypeError("A component failed."));
  assert.equal(host.stopped.value, true);
  assert.equal(bridge.frozen(before), false);
  finishWrite();
  await settle(40);
  assert.equal(writes, 1);
  await settle(250);
  assert.equal(bridge.frozen(before), true);
  const after = published(host.session.value);
  assert.equal(after.revision, before.revision);
  assert.deepEqual(after.state, before.state);
  assert.equal(writes, 1, "the stop's final publication repeats no provider write");
});

test("input admitted just before a Player error does not run after it", async (context) => {
  stubBrowser(context);
  const host = mount(context, () =>
    usePlayerSession({ bridge: inProcessBackend(), capabilities: { camera: false } }),
  );
  host.prepare(
    await sourceStart(
      host.bridge,
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

test("an observation whose publish causes a Player error admits neither the input nor a jump", async (context) => {
  stubBrowser(context);
  const { host, time } = mount(context, () => {
    const host = usePlayerSession({ bridge: inProcessBackend(), capabilities: { camera: false } });
    return { host, time: useDevelopmentTime(host, { autoSkip: false }, () => {}) };
  });
  // A component that fails while it renders the observed session, as Vue reports it to the Player at once.
  let failing = false;
  mount(context, () =>
    watch(
      host.session,
      () => {
        if (!failing) return;
        failing = false;
        host.reportHostError(new TypeError("A component failed."));
      },
      { flush: "sync" },
    ),
  );
  host.prepare(
    await sourceStart(
      host.bridge,
      'showPermanentButton "Help" {\n  say "pressed", instant\n}\nwait 5 s\nsay "waited", instant\nshowButton "Done"\nexit',
    ),
  );
  await host.activate();
  const [button] = host.permanentButtons.value;
  assert.ok(button);
  // Time passes, so the press's observation publishes a session.
  await settle(5);
  failing = true;
  await host.pressPermanentButton(button.buttonId);
  assert.equal(host.stopped.value, true);
  await settle();
  assert.deepEqual(said(host), []);

  host.prepare(
    await sourceStart(host.bridge, 'wait 5 s\nsay "waited", instant\nshowButton "Done"\nexit'),
  );
  await host.activate();
  await settle(5);
  failing = true;
  await time.advanceBy(10_000);
  assert.equal(host.stopped.value, true);
  assert.deepEqual(said(host), []);
  assert.ok(host.session.value!.state.observedSessionTimeMs < 5000);
});

test("a photo used in the same task as a Player error does not answer", async (context) => {
  stubBrowser(context);
  const host = mount(context, () =>
    usePlayerSession({ bridge: inProcessBackend(), capabilities: { camera: false } }),
  );
  host.prepare(
    await sourceStart(
      host.bridge,
      'let photo = askImage("Photo")\nsay "after photo", instant\nshowButton "Done"\nexit',
    ),
  );
  await host.activate();
  host.imageCapture.openCamera();
  await settle();
  assert.equal(host.imageCapture.view.value?.phase, "live");
  await host.imageCapture.takePhoto();
  assert.equal(host.imageCapture.view.value?.ready, true);
  host.reportHostError(new TypeError("A component failed."));
  const stopped = host.session.value;
  assert.equal((await answerWith(host, host.imageCapture.answer("button"))).kind, "retired");
  await nextTick();
  assert.equal(host.session.value, stopped);
  assert.equal(host.imageCapture.view.value, null, "the stopped request's steps close");
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
    usePlayerSession({
      bridge: inProcessBackend(),
      scriptStorage: provider,
      capabilities: { camera: false },
    }),
  );
  const time = mount(context, () => useDevelopmentTime(host, { autoSkip: false }, () => {}));
  await host.loadScriptStorage();
  host.prepare(
    await sourceStart(
      host.bridge,
      'wait 5 s\nsave 1 as "count"\nsay "after save", instant\nshowButton "Done"\nexit',
      () => ({ persistentScriptStorage: true }),
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
    usePlayerSession({
      bridge: inProcessBackend(),
      scriptStorage: provider,
      capabilities: { camera: false },
    }),
  );
  const rewind = mount(context, () => useDebugRewind(host));
  await host.loadScriptStorage();
  host.prepare(
    await sourceStart(
      host.bridge,
      'showButton "First"\nsave 1 as "count"\nshowButton "Second"\nexit',
      () => ({ persistentScriptStorage: true }),
    ),
  );
  await host.activate();
  await nextTick();
  const first = host.session.value && runtime.activatePlayerRuntimeButton(host.session.value);
  assert.ok(first);
  host.update(first.session);
  await settle();
  assert.equal(values.get("count"), 1);
  assert.equal(await backTo(rewind, 0), true);
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
    usePlayerSession({
      bridge: inProcessBackend(),
      scriptStorage: provider,
      capabilities: { camera: false },
    }),
  );
  await host.loadScriptStorage();
  host.prepare(
    await sourceStart(host.bridge, 'save 1 as "count"\nsay "after save", instant\nexit', () => ({
      persistentScriptStorage: true,
    })),
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

test("after a Player error, a debug export keeps the recording up to the error through Back, until the next Start", async (context) => {
  stubBrowser(context);
  const host = mount(context, () =>
    usePlayerSession({ bridge: inProcessBackend(), capabilities: { camera: false } }),
  );
  const rewind = mount(context, () => useDebugRewind(host));
  const create = await sourceStart(host.bridge, 'showButton "First"\nshowButton "Second"\nexit');
  host.prepare(create);
  await host.activate();
  await nextTick();
  const first = host.session.value && runtime.activatePlayerRuntimeButton(host.session.value);
  assert.ok(first);
  host.update(first.session);
  await settle();
  host.reportHostError(new TypeError("A component failed."));
  // The start, the answer, and the run that continued it.
  const atError = await host.debugRecording();
  assert.deepEqual(
    atError?.operations.map((operation) => operation.kind),
    ["run", "completeAction", "run"],
  );
  // Back shows an earlier state, from which the recorder begins anew; the export still shows the error's recording.
  assert.equal(await backTo(rewind, 0), true);
  assert.deepEqual(await host.debugRecording(), atError);
  assert.deepEqual(
    (await host.debugExportCandidate(() => shown, new AbortController().signal)).recording,
    atError,
  );
  // A new Start records its own session.
  host.prepare(create);
  await host.activate();
  assert.equal(host.hostError.value, null);
  assert.deepEqual(
    (await host.debugRecording())?.operations.map((operation) => operation.kind),
    ["run"],
  );
});

test("a debug export of a failed state the session cannot export names the failure and carries the last good state", async (context) => {
  stubBrowser(context);
  const host = mount(context, () =>
    usePlayerSession({ bridge: inProcessBackend(), capabilities: { camera: false } }),
  );
  // V8 cannot enumerate the keys of a list of about 134 million elements, so a state that holds one cannot be exported;
  // a list of 1,500 stands for it.
  const ownKeys = Reflect.ownKeys;
  context.mock.method(Reflect, "ownKeys", (target: Parameters<typeof Reflect.ownKeys>[0]) => {
    if (Array.isArray(target) && target.length > 1_000)
      throw new RangeError("Too many properties to enumerate");
    return ownKeys(target);
  });
  host.prepare(
    await sourceStart(
      host.bridge,
      'say "Counting", instant\nlet xs = (1..=1500).toList()\nlet zero = dynamic(0)\nlet result = 1 / zero\nexit\nfunction dynamic(value) {\n    return value\n}',
    ),
  );
  await host.activate();
  assert.equal(host.session.value?.state.status, "failed");
  const candidate = await host.debugExportCandidate(() => shown, new AbortController().signal);
  context.mock.restoreAll();
  let choices = NO_PERSONAL_CONTENT;
  for (const category of ["savedValues", "answers", "sessionText", "replay"] as const)
    choices = chooseDebugCategory(choices, candidate, category, true);
  const exported = async (frozen: DebugExportCandidate) =>
    parseDebugExport(
      await (
        await debugExportFile((await assembleDebugExport(frozen, choices)).exported, false)
      ).text(),
    );
  const read = await exported(candidate);
  // The division by zero in the fourth line, as the error dialog names it.
  assert.deepEqual(
    [read.incident.kind, read.incident.code, read.incident.path, read.incident.line],
    ["runtimeFailure", "TSR036", "main.tease", 4],
  );
  // The checkpoint is the recording's anchor, the last good state, and no earlier state stands in for the one shown.
  assert.equal(read.checkpointRole, "lastGood");
  assert.equal(read.replay?.anchorSnapshot, null);
  assert.equal(read.sections["storage"], undefined);
  assert.equal(replayDebugExport(read).kind, "incomplete");
  // What the player saw stays.
  const events = read.sections["eventsTail"];
  assert.ok(Array.isArray(events));
  assert.deepEqual(
    events.map((event: { kind?: unknown }) => event.kind),
    ["say", "runtimeFailure"],
  );
  // Once the session is no longer shown, its recording still names the failure.
  const ended = await exported({ ...candidate, session: null });
  assert.deepEqual(
    [ended.incident.code, ended.incident.path, ended.incident.line, ended.checkpointRole],
    ["TSR036", "main.tease", 4, "lastGood"],
  );
});

test("a debug export offers a photo only the replay saves, also after a Player error and Back, and replays with it", async (context) => {
  stubBrowser(context);
  const photo = "captured-media:44444444-4444-4444-8444-444444444444:1";
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const values = new Map<string, SerializableRuntimeValue>([["picture", photo]]);
  const provider: ScriptStorageProvider = {
    scope: "test",
    load: async () => [...values].map(([key, value]) => ({ key, value })),
    write: async (key, value) =>
      void (value === null ? values.delete(key) : values.set(key, value)),
    replace: async (entries) => {
      values.clear();
      for (const { key, value } of entries) values.set(key, value);
    },
    clear: async () => values.clear(),
  };
  const repository = new FakeMediaRepository();
  const data = new Blob([bytes], { type: "image/png" });
  await repository.add({
    namespace: "test",
    reference: photo,
    kind: "image",
    mimeType: "image/png",
    size: data.size,
    width: 1,
    height: 1,
    data,
  });
  const host = mount(context, () =>
    usePlayerSession({
      bridge: inProcessBackend(),
      scriptStorage: provider,
      capturedMedia: { repository },
      capabilities: { camera: false },
    }),
  );
  const rewind = mount(context, () => useDebugRewind(host));
  await host.loadScriptStorage();
  host.prepare(
    await sourceStart(
      host.bridge,
      'let picture = load "picture", default: ""\ndelete "picture"\nshowButton "First"\nsave picture as "picture"\nshowButton "Second"\nexit',
      () => ({ ...host.scriptStorageOptions() }),
    ),
  );
  // The candidate's photos with their uses, and the file with every category and the photo chosen, read back.
  const exported = async () => {
    const candidate = await host.debugExportCandidate(() => shown, new AbortController().signal);
    let choices = NO_PERSONAL_CONTENT;
    for (const category of ["savedValues", "answers", "sessionText", "replay", "photos"] as const)
      choices = chooseDebugCategory(choices, candidate, category, true);
    const assembled = await assembleDebugExport(candidate, chooseDebugPhoto(choices, photo, true));
    return {
      offered: candidate.photos.map((each) => [
        each.reference,
        each.usedBy.map((use) => use.relation),
      ]),
      read: parseDebugExport(await (await debugExportFile(assembled.exported, false)).text()),
    };
  };
  const label = () => {
    const foreground = view.playerRuntimeForeground(host.session.value!);
    return foreground?.kind === "show-button" ? foreground.label : null;
  };
  await host.activate();
  await settle();
  // At First, the photo is saved only in the state the recording begins with.
  assert.equal(label(), "First");
  assert.equal(values.has("picture"), false);
  const atFirst = await exported();
  assert.deepEqual(atFirst.offered, [[photo, ["savedValue"]]]);
  assert.equal(replayDebugExport(atFirst.read).kind, "reproduced");
  assert.deepEqual(
    atFirst.read.photos.map((each) => [each.reference, each.data]),
    [[photo, bytes]],
  );

  const first = runtime.activatePlayerRuntimeButton(host.session.value!);
  assert.ok(first);
  host.update(first.session);
  await settle();
  assert.equal(values.get("picture"), photo);
  host.reportHostError(new TypeError("A component failed."));
  // Back shows First again, without the photo saved; the export replays the calls up to the error.
  assert.equal(await backTo(rewind, 0), true);
  assert.equal(label(), "First");
  const afterBack = await exported();
  assert.deepEqual(afterBack.offered, [[photo, ["savedValue"]]]);
  assert.equal(replayDebugExport(afterBack.read).kind, "reproduced");
  assert.ok(afterBack.read.replay!.operations.length > atFirst.read.replay!.operations.length);
  assert.deepEqual(
    afterBack.read.photos.map((each) => [each.reference, each.data]),
    [[photo, bytes]],
  );
});

/**
 * Choose outcomes pauses at every draw: a repeating timer's first, at its creation (a `duration` draw), comes before the
 * repeat these tests pause at, and goes on naturally here.
 */
async function naturalCreationDraw(host: StopHost) {
  const created = host.session.value?.state.randomDraw;
  assert.ok(created, "the timer's creation draw waits");
  assert.equal(created.kind, "duration");
  assert.equal((await host.resolveRandomDraw(created.drawId, "natural"))?.kind, "resolved");
}

// A photo the session never took is released when Debug's rewind leaves its session, also while a random draw holds
// that session; the photo it took stays for the state that holds it, Back and Return included (#1882).
for (const atDraw of [false, true])
  test(`a photo still encoded when Back ${atDraw ? "leaves a session held at a random draw" : "leaves its session"} is released, and the one the session took stays`, async (context) => {
    stubBrowser(context);
    encoding.started = 0;
    const host = mount(context, () =>
      usePlayerSession({ bridge: inProcessBackend(), capabilities: { camera: true } }),
    );
    const rewind = mount(context, () => useDebugRewind(host));
    if (atDraw) host.setRandomControl({ sites: [] });
    host.prepare(
      await sourceStart(
        host.bridge,
        [
          "let a = takePhoto()",
          'showButton "Next"',
          ...(atDraw ? ["let tick = timer(duration: (1..=2) s, async: true, repeat: true)"] : []),
          "let b = takePhoto()",
          'showButton "Done"',
          "exit",
        ].join("\n"),
      ),
    );
    await host.activate();
    const binding = (name: string) =>
      runtime
        .playerRuntimeSnapshot(host.session.value!)
        .frames[0]!.bindings.find((entry) => entry.name === name)?.value;
    const until = async (done: () => boolean, message: string) => {
      for (let turn = 0; !done(); turn++) {
        assert.ok(turn < 200, message);
        await settle(10);
      }
    };
    await until(() => typeof binding("a") === "string", "the first photo was not taken");
    const taken = binding("a");
    assert.ok(typeof taken === "string" && taken.endsWith(":1"));
    // The store numbers its photos: the next one taken is the second.
    const next = taken.replace(/:1$/u, ":2");
    const release = holdEncoding();
    const pressed = runtime.activatePlayerRuntimeButton(host.session.value!);
    assert.ok(pressed);
    host.update(pressed.session);
    if (atDraw) await naturalCreationDraw(host);
    await until(() => encoding.started === 2, "the second photo was not encoded");
    if (atDraw) {
      // The timer repeats, and Debug's random control pauses the session at its next duration's draw.
      const shown = host.session.value!;
      host.update(
        runtime.observePlayerRuntimeTime(shown, shown.state.observedSessionTimeMs + 3_000, [])
          .session,
      );
      await until(() => host.session.value?.state.randomDraw != null, "no draw paused the session");
    }
    // Held at the draw, the photo is made but has no session to go to, so it waits for the draw; Back then leaves
    // that session with no service pass under way. Without the draw, Back comes while the photo is still encoded.
    if (atDraw) {
      release();
      await settle();
    }
    assert.equal(await backTo(rewind, 0), true);
    if (!atDraw) release();
    await settle();
    assert.equal(host.resolveAsset(next), null, "the photo the session never took is held");
    assert.notEqual(host.resolveAsset(taken), null);
    // Return reinstates the session Back left; its photo is taken anew, and the first stays.
    assert.equal(await rewind.returnToSession(), true);
    if (atDraw) host.setRandomControl(null);
    await until(() => typeof binding("b") === "string", "the session's photo was not taken");
    const retaken = binding("b");
    assert.ok(typeof retaken === "string" && retaken !== next);
    assert.notEqual(host.resolveAsset(retaken), null);
    assert.notEqual(host.resolveAsset(taken), null);
    assert.equal(host.resolveAsset(next), null);
  });

// A repeating timer's draw that the service's own observation reaches holds the photo back (`randomDrawPending`): the
// engine never took it, so it is released, and the capture takes a new one once the draw is decided (#1882; the case of
// Astra's r1 review). Only the browser's clock moves; nothing is injected into the session.
test("a photo held back at a random draw the capture's observation reaches is released, and the capture takes a new one", async (context) => {
  stubBrowser(context);
  encoding.started = 0;
  let now = 0;
  context.mock.method(performance, "now", () => now);
  const host = mount(context, () =>
    usePlayerSession({ bridge: inProcessBackend(), capabilities: { camera: true } }),
  );
  host.setRandomControl({ sites: [] });
  host.prepare(
    await sourceStart(
      host.bridge,
      [
        "let first = takePhoto()",
        'showButton "Next"',
        "let tick = timer(duration: (1..=2) s, async: true, repeat: true)",
        "let second = takePhoto()",
        'showButton "Done"',
        "exit",
      ].join("\n"),
    ),
  );
  const binding = (name: string) =>
    runtime
      .playerRuntimeSnapshot(host.session.value!)
      .frames[0]!.bindings.find((entry) => entry.name === name)?.value;
  const until = async (done: () => boolean, message: string) => {
    for (let turn = 0; !done(); turn++) {
      assert.ok(turn < 400, message);
      await settle(5);
    }
  };
  await host.activate();
  await until(() => typeof binding("first") === "string", "the first photo was not taken");
  const first = binding("first");
  assert.ok(typeof first === "string" && first.endsWith(":1"));
  const heldBack = first.replace(/:1$/u, ":2");
  const release = holdEncoding();
  context.after(release);
  const pressed = runtime.activatePlayerRuntimeButton(host.session.value!);
  assert.ok(pressed);
  host.update(pressed.session);
  await naturalCreationDraw(host);
  await until(() => encoding.started === 2, "the second photo was not encoded");
  assert.equal(host.session.value!.state.randomDraw, null);
  // Three seconds pass while the photo is encoded; the capture's own observation then reaches the timer's draw.
  now = 3_000;
  release();
  await until(() => host.session.value!.state.randomDraw != null, "no draw paused the session");
  await settle(40);
  assert.equal(binding("second"), undefined);
  assert.equal(host.resolveAsset(heldBack), null, "the photo the engine did not take is held");
  assert.notEqual(host.resolveAsset(first), null);
  host.setRandomControl(null);
  await until(() => typeof binding("second") === "string", "the capture did not go on");
  const second = binding("second");
  assert.ok(typeof second === "string" && second !== heldBack);
  assert.notEqual(host.resolveAsset(second), null);
});
