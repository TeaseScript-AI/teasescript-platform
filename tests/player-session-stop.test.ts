import assert from "node:assert/strict";
import test, { before, type TestContext } from "node:test";
import { effectScope, nextTick, watch, type Ref } from "vue";

import {
  assembleDebugExport,
  chooseDebugCategory,
  chooseDebugPhoto,
  NO_PERSONAL_CONTENT,
  type DebugExportCandidate,
} from "../player/debug-export-assembly.js";
import { debugExportFile, parseDebugExport, replayDebugExport } from "../player/debug-export.js";
import type { DebugRecorder, DebugRecording } from "../player/debug-recorder.js";
import type * as RuntimeAdapter from "../player/runtime-adapter.js";
import type { PlayerRuntimeSession } from "../player/runtime-adapter.js";
import type { ScriptStorageProvider } from "../player/script-storage.js";
import type { SerializableRuntimeValue } from "../src/index.js";
import { FakeMediaRepository } from "./helpers/fake-media-repository.js";
import { loadPlayerModule } from "./helpers/player-modules.js";

// A Player error stops the session where it stands (PLAYER-UI "Session end and failure"). Input and the work that
// continues it take their session from `observe()`, which gives none once stopped; these include continuations that
// were under way when the error came.
interface StopHost {
  readonly session: Readonly<Ref<PlayerRuntimeSession | null>>;
  readonly hostError: Readonly<Ref<string | null>>;
  readonly stopped: Readonly<Ref<boolean>>;
  readonly permanentButtons: Readonly<Ref<readonly { readonly buttonId: number }[]>>;
  readonly imageCapture: {
    readonly view: Readonly<Ref<{ readonly phase: string; readonly ready: boolean } | null>>;
    openCamera(): void;
    takePhoto(): Promise<void>;
    use(session: PlayerRuntimeSession): RuntimeAdapter.PlayerRuntimeControlResult | null;
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
  debugRecording(): DebugRecording | null;
  debugExportCandidate(
    shown: Pick<DebugExportCandidate, "player" | "host">,
  ): Promise<DebugExportCandidate>;
  loadScriptStorage(): Promise<void>;
  scriptStorageOptions(): RuntimeAdapter.PlayerRuntimeSessionOptions;
  prepare(create: (options: { readonly recorder: DebugRecorder }) => PlayerRuntimeSession): void;
  activate(): Promise<void>;
  update(session: PlayerRuntimeSession): void;
}
let usePlayerSession: (options: {
  scriptStorage?: ScriptStorageProvider;
  capturedMedia?: { repository: FakeMediaRepository };
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
  const session: Record<string, unknown> = await loadPlayerModule(
    "player/vue/src/usePlayerSession.ts",
  );
  const rewind: Record<string, unknown> = await loadPlayerModule(
    "player/vue/src/useDebugRewind.ts",
  );
  const time: Record<string, unknown> = await loadPlayerModule(
    "player/vue/src/useDevelopmentTime.ts",
  );
  const adapter: Record<string, unknown> = await loadPlayerModule("player/runtime-adapter.ts");
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

test("an observation whose publish causes a Player error admits neither the input nor a jump", async (context) => {
  stubBrowser(context);
  const { host, time } = mount(context, () => {
    const host = usePlayerSession({ capabilities: { camera: false } });
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
  host.prepare(() =>
    runtime.createPlayerRuntimeSession(
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

  host.prepare(() =>
    runtime.createPlayerRuntimeSession('wait 5 s\nsay "waited", instant\nshowButton "Done"\nexit'),
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
  const host = mount(context, () => usePlayerSession({ capabilities: { camera: false } }));
  host.prepare(({ recorder }) =>
    runtime.createPlayerRuntimeSession(
      'let photo = askImage("Photo")\nsay "after photo", instant\nshowButton "Done"\nexit',
      { recorder },
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
  assert.equal(host.imageCapture.use(stopped!), null);
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

test("after a Player error, a debug export keeps the recording up to the error through Back, until the next Start", async (context) => {
  stubBrowser(context);
  const host = mount(context, () => usePlayerSession({ capabilities: { camera: false } }));
  const rewind = mount(context, () => useDebugRewind(host));
  const create = ({ recorder }: { readonly recorder: DebugRecorder }) =>
    runtime.createPlayerRuntimeSession('showButton "First"\nshowButton "Second"\nexit', {
      recorder,
    });
  host.prepare(create);
  await host.activate();
  await nextTick();
  const first = host.session.value && runtime.activatePlayerRuntimeButton(host.session.value);
  assert.ok(first);
  host.update(first.session);
  await settle();
  host.reportHostError(new TypeError("A component failed."));
  // The start, the answer, and the run that continued it.
  const atError = host.debugRecording();
  assert.deepEqual(
    atError?.operations.map((operation) => operation.kind),
    ["run", "completeAction", "run"],
  );
  // Back shows an earlier state, from which the recorder begins anew; the export still shows the error's recording.
  assert.equal(await rewind.back(0), true);
  assert.deepEqual(host.debugRecording(), atError);
  assert.deepEqual((await host.debugExportCandidate(shown)).recording, atError);
  // A new Start records its own session.
  host.prepare(create);
  await host.activate();
  assert.equal(host.hostError.value, null);
  assert.deepEqual(
    host.debugRecording()?.operations.map((operation) => operation.kind),
    ["run"],
  );
});

test("a debug export of a failed state the session cannot export names the failure and carries the last good state", async (context) => {
  stubBrowser(context);
  const host = mount(context, () => usePlayerSession({ capabilities: { camera: false } }));
  // V8 cannot enumerate the keys of a list of about 134 million elements, so a state that holds one cannot be exported;
  // a list of 1,500 stands for it.
  const ownKeys = Reflect.ownKeys;
  context.mock.method(Reflect, "ownKeys", (target: Parameters<typeof Reflect.ownKeys>[0]) => {
    if (Array.isArray(target) && target.length > 1_000)
      throw new RangeError("Too many properties to enumerate");
    return ownKeys(target);
  });
  host.prepare(({ recorder }) =>
    runtime.createPlayerRuntimeSession(
      'say "Counting", instant\nlet xs = (1..=1500).toList()\nlet zero = dynamic(0)\nlet result = 1 / zero\nexit\nfunction dynamic(value) {\n    return value\n}',
      { recorder },
    ),
  );
  await host.activate();
  assert.equal(host.session.value?.state.status, "failed");
  const candidate = await host.debugExportCandidate(shown);
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
      scriptStorage: provider,
      capturedMedia: { repository },
      capabilities: { camera: false },
    }),
  );
  const rewind = mount(context, () => useDebugRewind(host));
  await host.loadScriptStorage();
  host.prepare(({ recorder }) =>
    runtime.createPlayerRuntimeSession(
      'let picture = load "picture", default: ""\ndelete "picture"\nshowButton "First"\nsave picture as "picture"\nshowButton "Second"\nexit',
      { recorder, ...host.scriptStorageOptions() },
    ),
  );
  // The candidate's photos with their uses, and the file with every category and the photo chosen, read back.
  const exported = async () => {
    const candidate = await host.debugExportCandidate(shown);
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
    const foreground = runtime.playerRuntimeForeground(host.session.value!);
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
  assert.equal(await rewind.back(0), true);
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
