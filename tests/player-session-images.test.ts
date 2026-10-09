import assert from "node:assert/strict";
import test, { before, type TestContext } from "node:test";
import { effectScope, nextTick, type Ref } from "vue";
import { createServer } from "vite";

import {
  answerPlayerRuntimeImage,
  createPlayerRuntimeSession,
  submitPlayerRuntimeComposer,
  observePlayerRuntimeTime,
  playerRuntimeForeground,
  type PlayerRuntimeSession,
  type PlayerRuntimeSessionOptions,
  playerRuntimeSnapshot,
} from "../player/runtime-adapter.js";
import type { DebugExportCandidate } from "../player/debug-export-assembly.js";
import type { ScriptStorageProvider } from "../player/script-storage.js";
import type { CapturedMediaAdmission, SerializableRuntimeValue } from "../src/index.js";
import { FakeMediaRepository } from "./helpers/fake-media-repository.js";

interface ImageHost {
  readonly session: Readonly<Ref<PlayerRuntimeSession | null>>;
  readonly notices: Readonly<Ref<readonly { readonly key: string; readonly message: string }[]>>;
  dismissNotice(key: string): void;
  resolveAsset(path: string): string | null;
  stageImageFailure(src: string | null): void;
  readonly images: {
    store(
      file: File,
      filters: { types: readonly string[] | null; mime: readonly string[] | null },
    ): Promise<{ readonly reference: string } | { readonly message: string }>;
    readonly admission: CapturedMediaAdmission;
    discard(reference: string): void;
  };
  loadScriptStorage(): Promise<void>;
  scriptStorageOptions(): PlayerRuntimeSessionOptions;
  prepare(create: (options: PlayerRuntimeSessionOptions) => PlayerRuntimeSession): void;
  debugExportCandidate(
    shown: Pick<DebugExportCandidate, "player" | "host">,
  ): Promise<DebugExportCandidate>;
  activate(): Promise<void>;
  update(session: PlayerRuntimeSession): void;
}
let usePlayerSession: (options: {
  resolveAsset?: (path: string) => string | null;
  scriptStorage?: ScriptStorageProvider;
  capturedMedia?: { repository: FakeMediaRepository };
  decodeImage?: (data: Blob) => Promise<{ width: number; height: number }>;
}) => ImageHost;

// Load the real Vue composable through the existing build tool: its browser-source imports use Vite resolution.
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

// Audio elements the Player host created, so a test can make one fail to load.
const audioElements: EventTarget[] = [];

// The browser surface the Player host touches without a camera; no Web Locks, so durable writes are not coordinated.
function stubBrowser(context: TestContext) {
  const values = {
    document: new EventTarget(),
    window: new EventTarget(),
    navigator: {},
    Audio: class extends EventTarget {
      constructor() {
        super();
        audioElements.push(this);
      }
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
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const anyImage = { types: null, mime: null };

async function until(condition: () => boolean, message: string) {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function chosen(host: ImageHost, name: string) {
  const stored = await host.images.store(new File([PNG], name), anyImage);
  assert.ok("reference" in stored, name);
  return stored.reference;
}

function answer(host: ImageHost, reference: string) {
  const session = host.session.value;
  assert.ok(session);
  const result = answerPlayerRuntimeImage(session, reference, host.images.admission);
  assert.equal(result?.outcome.kind, "completed");
  host.update(result!.session);
}

test("a chosen image is session media: kept durably only when saved, and released when the Player unmounts", async (context) => {
  stubBrowser(context);
  const entries = new Map<string, SerializableRuntimeValue>();
  const provider: ScriptStorageProvider = {
    scope: "images",
    load: async () => [...entries].map(([key, value]) => ({ key, value })),
    write: async (key, value) =>
      void (value === null ? entries.delete(key) : entries.set(key, value)),
    replace: async (next) => {
      entries.clear();
      for (const { key, value } of next) entries.set(key, value);
    },
    clear: async () => entries.clear(),
  };
  const repository = new FakeMediaRepository();
  const scope = effectScope();
  const host = scope.run(() =>
    usePlayerSession({
      scriptStorage: provider,
      capturedMedia: { repository },
      decodeImage: async () => ({ width: 2, height: 2 }),
    }),
  );
  assert.ok(host);
  context.after(() => scope.stop());
  await host.loadScriptStorage();
  host.prepare(() =>
    createPlayerRuntimeSession(
      'let first = askImage("First")\nlet second = askImage("Second")\nsave second as "kept"\nexit',
      host.scriptStorageOptions(),
    ),
  );
  await host.activate();
  assert.equal(playerRuntimeForeground(host.session.value!)?.kind, "ask-image");

  // A file that is not an image is refused, and nothing is stored.
  const refused = await host.images.store(new File(["hello"], "notes.png"), anyImage);
  assert.ok("message" in refused);

  const first = await chosen(host, "first.png");
  assert.equal(host.images.admission.holds(first, "image"), true);
  answer(host, first);
  const second = await chosen(host, "second.png");
  answer(host, second);
  await until(() => host.session.value?.state.status === "halted", "the save was not serviced");

  // Only the saved image became durable, under the script's storage scope.
  assert.deepEqual([...entries], [["kept", second]]);
  assert.deepEqual(await repository.listReferences("images"), [second]);
  // Unmounting releases the session media; the saved image stays in durable storage.
  scope.stop();
  await until(
    () => !host.images.admission.holds(first, "image"),
    "the session media was not released",
  );
  assert.equal(host.images.admission.holds(second, "image"), false);
  assert.deepEqual(await repository.listReferences("images"), [second]);
});

test("a debug export candidate is the state when it was asked for, while play continues during its photo reads", async (context) => {
  stubBrowser(context);
  const scope = effectScope();
  const host = scope.run(() =>
    usePlayerSession({ decodeImage: async () => ({ width: 1, height: 1 }) }),
  );
  assert.ok(host);
  context.after(() => scope.stop());
  host.prepare((options) =>
    createPlayerRuntimeSession(
      'let pick = askImage("Picture")\nlet name = askText "Name"\nsay "After ${name}"\nexit',
      options,
    ),
  );
  await host.activate();
  answer(host, await chosen(host, "used.png"));
  const asked = host.session.value!;
  // The Player's event and transcript lists grow with play, so the state asked for is their length then.
  const events = [...asked.events];
  const transcriptEntries = [...asked.transcriptEntries];
  // So is its state, which play changes in place.
  const askedSnapshot = playerRuntimeSnapshot(asked);
  const pending = host.debugExportCandidate({
    player: {},
    host: { stage: { status: "hidden", path: null }, media: [], notices: [], debugLog: null },
  });
  // The player answers before the candidate has read the photo the session used.
  host.update(submitPlayerRuntimeComposer(asked, "later answer")!.session);
  assert.equal(host.session.value?.state.status, "halted");
  const candidate = await pending;
  assert.deepEqual(candidate.session?.snapshot, askedSnapshot);
  assert.notEqual(asked.events.length, events.length, "play continued");
  assert.deepEqual(candidate.session?.events, events);
  assert.deepEqual(candidate.session?.transcriptEntries, transcriptEntries);
  assert.deepEqual(candidate.recording?.endSnapshot, askedSnapshot);
  assert.equal(candidate.photos.length, 1);
});

test("an image that never answered can be dropped, and the runtime admits only stored images", async (context) => {
  stubBrowser(context);
  const scope = effectScope();
  const host = scope.run(() =>
    usePlayerSession({ decodeImage: async () => ({ width: 1, height: 1 }) }),
  );
  assert.ok(host);
  context.after(() => scope.stop());
  host.prepare(() => createPlayerRuntimeSession("let pick = askImage()\nshowImage pick\nexit"));
  await host.activate();
  const reference = await chosen(host, "late.png");
  host.images.discard(reference);
  assert.equal(host.images.admission.holds(reference, "image"), false);
  const result = answerPlayerRuntimeImage(host.session.value!, reference, host.images.admission);
  assert.equal(result?.outcome.kind, "invalidPayload");
  assert.equal(playerRuntimeForeground(result!.session)?.kind, "ask-image");
});

test("each image request that allows only the camera is reported as a Player notice while it waits", async (context) => {
  stubBrowser(context);
  const scope = effectScope();
  const host = scope.run(() => usePlayerSession({}));
  assert.ok(host);
  context.after(() => scope.stop());
  const keys = () => host.notices.value.map((notice) => notice.key);
  const cameraOnly =
    'timer async 2 s {\n  let late = askImage("Timer", allowFile: false)\n}\nlet pick = askImage(allowFile: false)\nexit';
  host.prepare(() => createPlayerRuntimeSession(cameraOnly));
  await host.activate();
  await until(() => keys().includes("image-needs-camera"), "the notice was not published");
  // A dismissal holds for its request, while the session goes on.
  host.dismissNotice("image-needs-camera");
  host.update({ ...host.session.value! });
  await nextTick();
  assert.equal(keys().includes("image-needs-camera"), false);
  // The timer's request that replaces it is another request, reported again.
  host.update(observePlayerRuntimeTime(host.session.value!, 2_000).session);
  await until(() => keys().includes("image-needs-camera"), "the timer's request was not reported");
  // So is the same request in a new run of the same story.
  host.dismissNotice("image-needs-camera");
  host.prepare(() => createPlayerRuntimeSession(cameraOnly));
  await host.activate();
  await until(
    () => keys().includes("image-needs-camera"),
    "the new run's request was not reported",
  );
  // A new session without such a request withdraws it.
  host.prepare(() => createPlayerRuntimeSession('let pick = askImage("Add an image")\nexit'));
  await host.activate();
  await until(() => !keys().includes("image-needs-camera"), "the notice was not withdrawn");
});

test("media the script refers to but the Player cannot use is a warning, once per session and path", async (context) => {
  stubBrowser(context);
  const packageFiles = new Set(["sounds/broken.wav", "videos/intro.mp4"]);
  const scope = effectScope();
  const host = scope.run(() =>
    usePlayerSession({
      resolveAsset: (path) => (packageFiles.has(path) ? `/files/${path}` : null),
      decodeImage: async () => ({ width: 1, height: 1 }),
    }),
  );
  assert.ok(host);
  context.after(() => scope.stop());
  const messages = () => host.notices.value.map((notice) => notice.message).sort();
  const script = [
    'showImage "images/missing.png"',
    'playAudio async "sounds/missing.wav"',
    'playAudio async "sounds/broken.wav"',
    'playVideo async "videos/intro.mp4"',
    'playVideo async "videos/missing.mp4"',
    "let first = askImage()",
    "showImage first",
    "let second = askImage()",
    'showImage "images/missing.png"',
    "let third = askImage()",
    "exit",
  ].join("\n");
  host.prepare(() => createPlayerRuntimeSession(script));
  await host.activate();
  // An async play waits for its load: the missing sound is reported while the run waits for the next one.
  await until(() => messages().length === 2, "the missing image and sound were not reported");
  audioElements.at(-1)!.dispatchEvent(new Event("error"));
  // The video that exists is not reported: the Player cannot play video yet.
  await until(
    () => messages().length === 4,
    "the failed sound and missing video were not reported",
  );
  assert.deepEqual(messages(), [
    "Audio could not be loaded: sounds/broken.wav (main.tease, line 3)",
    "Audio not found: sounds/missing.wav (main.tease, line 2)",
    "Image not found: images/missing.png",
    "Video not found: videos/missing.mp4 (main.tease, line 5)",
  ]);
  assert.equal(playerRuntimeForeground(host.session.value!)?.kind, "ask-image");
  for (const notice of host.notices.value) host.dismissNotice(notice.key);

  // A captured image is no package file, so neither showing it nor a failure to load it is reported.
  answer(host, await chosen(host, "photo.png"));
  await nextTick();
  host.stageImageFailure(
    host.resolveAsset(playerRuntimeSnapshot(host.session.value!).stageImage!)!,
  );
  // The same missing image shown again in this session is not reported again.
  answer(host, await chosen(host, "other.png"));
  await nextTick();
  assert.equal(playerRuntimeSnapshot(host.session.value!).stageImage, "images/missing.png");
  assert.deepEqual(messages(), []);

  // A new session reports it again.
  host.prepare(() => createPlayerRuntimeSession(script));
  await host.activate();
  await until(() => messages().length === 2, "the new session did not report the missing media");
});

test("a package image the Stage cannot load is reported while the Stage shows it", async (context) => {
  stubBrowser(context);
  const scope = effectScope();
  const host = scope.run(() => usePlayerSession({ resolveAsset: (path) => `/files/${path}` }));
  assert.ok(host);
  context.after(() => scope.stop());
  const script = 'showImage "images/corrupt.png"\nlet pick = askImage()\nexit';
  host.prepare(() => createPlayerRuntimeSession(script));
  await host.activate();
  // A late failure of an image the Stage no longer shows is not reported.
  host.stageImageFailure("/files/images/replaced.png");
  assert.equal(host.notices.value.length, 0);
  host.stageImageFailure("/files/images/corrupt.png");
  host.stageImageFailure("/files/images/corrupt.png");
  assert.deepEqual(
    host.notices.value.map((notice) => [notice.key, notice.message]),
    [["unusable-media:images/corrupt.png", "Image could not be loaded: images/corrupt.png"]],
  );
  // A new session showing it on the same Stage gets no new browser error, but is reported again.
  host.dismissNotice("unusable-media:images/corrupt.png");
  host.prepare(() => createPlayerRuntimeSession(script));
  await host.activate();
  await nextTick();
  assert.deepEqual(
    host.notices.value.map((notice) => notice.message),
    ["Image could not be loaded: images/corrupt.png"],
  );
  // Once the Stage shows another source, such as a development override, the failure no longer describes it.
  host.dismissNotice("unusable-media:images/corrupt.png");
  host.stageImageFailure(null);
  host.prepare(() => createPlayerRuntimeSession(script));
  await host.activate();
  await nextTick();
  assert.equal(host.notices.value.length, 0);
});
