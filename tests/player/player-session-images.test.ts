import assert from "node:assert/strict";
import test, { before, type TestContext } from "node:test";
import { effectScope, nextTick, type Ref } from "vue";

import {
  submitPlayerRuntimeComposer as rawSubmitPlayerRuntimeComposer,
  observePlayerRuntimeTime as rawObservePlayerRuntimeTime,
  type PlayerRuntimeSession,
  type PlayerRuntimeSessionOptions,
  playerRuntimeSnapshot as rawPlayerRuntimeSnapshot,
} from "../../player/runtime/runtime-adapter.js";
import { compilePlayerProject } from "../../player/runtime/compile-project.js";
import { preparedPlan, sourceStart, type PlanStart } from "../helpers/prepared-plan.js";
import type { PlayerBridge } from "../../player/runtime/player-bridge.js";
import {
  playerRuntimeForeground,
  playerRuntimeMedia,
  type PlayerSession,
} from "../../player/runtime/runtime-view.js";
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
import {
  memoryKeptSessionStore,
  type KeptSessionStore,
} from "../../player/persistence/kept-sessions.js";
import type { ScriptStorageProvider } from "../../player/persistence/script-storage.js";
import type { SerializableRuntimeValue } from "../../src/index.js";
import { FakeMediaRepository } from "../helpers/player/fake-media-repository.js";
import { loadPlayerModule } from "../helpers/player-modules.js";
import { answerWith, type Intent } from "../helpers/player/player-input.js";
import { loadHostFacade, onHost } from "../helpers/player/host-sessions.js";
import { inProcessBackend } from "../helpers/player/worker-topology.js";

// The adapter's functions, also on the sessions the composables' host holds (`helpers/player/host-sessions.ts`).
const submitPlayerRuntimeComposer = onHost(rawSubmitPlayerRuntimeComposer);
const observePlayerRuntimeTime = onHost(rawObservePlayerRuntimeTime);
const playerRuntimeSnapshot = onHost(rawPlayerRuntimeSnapshot);

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
    discard(reference: string): void;
  };
  /** The presented `askImage` request's steps: a chosen image becomes the preview, which "Use image" answers with. */
  readonly imageCapture: { choose(reference: string): boolean; answer(input: "button"): Intent };
  loadScriptStorage(): Promise<void>;
  scriptStorageOptions(): PlayerRuntimeSessionOptions;
  prepare(create: PlanStart): void;
  readonly bridge: Promise<PlayerBridge>;
  prepareScript(plan: string, create: PlanStart): Promise<void>;
  readonly activation: Readonly<Ref<"start" | "continue" | null>>;
  debugExportCandidate(
    details: () => Pick<DebugExportCandidate, "player" | "host">,
    wanted: AbortSignal,
  ): Promise<DebugExportCandidate>;
  activate(): Promise<void>;
  update(session: PlayerRuntimeSession): void;
  readonly inputSection: unknown;
  setRandomControl(control: { readonly sites: readonly [] } | null): void;
  forgetRandomHistory(): void;
  readonly randomRevision: Readonly<Ref<number>>;
  readonly hostError: Readonly<Ref<string | null>>;
  prepareRestore(given: PlayerSession): void;
  setDebugMode(on: boolean): void;
  readonly stopped: Readonly<Ref<boolean>>;
}
let usePlayerSession: (options: {
  readonly bridge: Promise<PlayerBridge>;
  resolveAsset?: (path: string) => string | null;
  scriptStorage?: ScriptStorageProvider;
  capturedMedia?: { repository: FakeMediaRepository };
  keptSessions?: KeptSessionStore;
  decodeImage?: (data: Blob) => Promise<{ width: number; height: number }>;
}) => ImageHost;

// Load the real Vue composable through the existing build tool: its browser-source imports use Vite resolution.

/**
 * The session the composable shows, as the host's session it is: this file declares it as an adapter session for its
 * adapter calls, which reach the host through `onHost`.
 */
const shown = (host: { readonly session: Readonly<Ref<unknown>> }) => {
  // EVIDENCE: invariant: the composable's `session` holds the host's sessions (`PlayerSession`), whatever this file declares.
  return host.session.value as PlayerSession;
};
before(async () => {
  await loadHostFacade();
  const module: Record<string, unknown> = await loadPlayerModule(
    "player/vue/src/session/usePlayerSession.ts",
  );
  assert.equal(typeof module.usePlayerSession, "function");
  // EVIDENCE: validation: Vite loaded the real source module and the export is callable; this is its tested host API.
  usePlayerSession = module.usePlayerSession as typeof usePlayerSession;
});

// Audio elements the Player host created, so a test can make one fail to load.
const audioElements: (EventTarget & { src: string })[] = [];

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

/** Makes a chosen image the request's preview and answers with it, as "Use image" does. */
async function answer(host: ImageHost, reference: string) {
  assert.ok(host.session.value);
  assert.equal(host.imageCapture.choose(reference), true);
  const result = await answerWith(host, host.imageCapture.answer("button"));
  assert.equal(result.outcome?.kind, "completed");
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
      bridge: inProcessBackend(),
      scriptStorage: provider,
      capturedMedia: { repository },
      decodeImage: async () => ({ width: 2, height: 2 }),
    }),
  );
  assert.ok(host);
  context.after(() => scope.stop());
  await host.loadScriptStorage();
  host.prepare(
    await sourceStart(
      host.bridge,
      'let first = askImage("First")\nlet second = askImage("Second")\nsave second as "kept"\nexit',
      () => host.scriptStorageOptions(),
    ),
  );
  await host.activate();
  assert.equal(playerRuntimeForeground(host.session.value!)?.kind, "ask-image");

  // A file that is not an image is refused, and nothing is stored.
  const refused = await host.images.store(new File(["hello"], "notes.png"), anyImage);
  assert.ok("message" in refused);

  const first = await chosen(host, "first.png");
  assert.notEqual(host.resolveAsset(first), null, "the chosen image is session media");
  await answer(host, first);
  const second = await chosen(host, "second.png");
  await answer(host, second);
  await until(() => host.session.value?.state.status === "halted", "the save was not serviced");

  // Only the saved image became durable, under the script's storage scope.
  assert.deepEqual([...entries], [["kept", second]]);
  assert.deepEqual(await repository.listReferences("images"), [second]);
  // Unmounting releases the session media; the saved image stays in durable storage.
  scope.stop();
  await until(() => host.resolveAsset(first) === null, "the session media was not released");
  assert.equal(host.resolveAsset(second), null);
  assert.deepEqual(await repository.listReferences("images"), [second]);
});

test("a debug export candidate is the state when it was asked for, while play continues during its photo reads", async (context) => {
  stubBrowser(context);
  const scope = effectScope();
  const host = scope.run(() =>
    usePlayerSession({
      bridge: inProcessBackend(),
      decodeImage: async () => ({ width: 1, height: 1 }),
    }),
  );
  assert.ok(host);
  context.after(() => scope.stop());
  host.prepare(
    await sourceStart(
      host.bridge,
      'let pick = askImage("Picture")\nlet name = askText "Name"\nsay "After ${name}", instant\nexit',
    ),
  );
  await host.activate();
  await answer(host, await chosen(host, "used.png"));
  const asked = host.session.value!;
  // The Player's event and transcript lists grow with play, so the state asked for is their length then.
  const events = [...asked.events];
  const transcriptEntries = [...asked.transcriptEntries];
  // So is its state, which play changes in place.
  const askedSnapshot = playerRuntimeSnapshot(asked);
  const pending = host.debugExportCandidate(
    () => ({
      player: {},
      host: { stage: { status: "hidden", path: null }, media: [], notices: [], debugLog: null },
    }),
    new AbortController().signal,
  );
  // The capture is delivered; the player answers while the candidate reads the photo the session used.
  await new Promise((resolve) => setTimeout(resolve, 0));
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

test("after a reload, Continue's debug export offers the photo its state holds, which no recorded call used", async (context) => {
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
  const keptSessions = memoryKeptSessionStore();
  const { plan } = compilePlayerProject(
    'let picture = askImage("Picture")\nshowImage picture\nshowButton "First"\nexit',
  );
  assert.ok(plan);
  // One page of the Player; a reload is a new one with the same browser storage.
  const page = async () => {
    const scope = effectScope();
    const host = scope.run(() =>
      usePlayerSession({
        bridge: inProcessBackend(),
        scriptStorage: provider,
        capturedMedia: { repository },
        keptSessions,
        decodeImage: async () => ({ width: 2, height: 2 }),
      }),
    );
    assert.ok(host);
    context.after(() => scope.stop());
    await host.loadScriptStorage();
    const held = await preparedPlan(host.bridge, plan);
    await host.prepareScript(held, { plan: held, options: () => host.scriptStorageOptions() });
    return { host, scope };
  };
  const before = await page();
  await before.host.activate();
  const photo = await chosen(before.host, "kept.png");
  await answer(before.host, photo);
  await until(
    () => playerRuntimeForeground(before.host.session.value!)?.kind === "show-button",
    "the session did not reach First",
  );
  const kept = async () => JSON.stringify(await keptSessions.session("images")).includes(photo);
  for (let tries = 0; !(await kept()); tries += 1) {
    assert.ok(tries < 400, "the session was not kept");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  before.scope.stop();

  const after = await page();
  assert.equal(after.host.activation.value, "continue");
  await after.host.activate();
  const candidate = await after.host.debugExportCandidate(
    () => ({
      player: {},
      host: { stage: { status: "loaded", path: null }, media: [], notices: [], debugLog: null },
    }),
    new AbortController().signal,
  );
  assert.deepEqual(
    candidate.photos.map((each) => [each.reference, each.usedBy, each.byteLength]),
    [[photo, [], PNG.length]],
  );
  let choices = NO_PERSONAL_CONTENT;
  for (const category of ["savedValues", "answers", "sessionText", "replay", "photos"] as const)
    choices = chooseDebugCategory(choices, candidate, category, true);
  const { exported } = await assembleDebugExport(candidate, chooseDebugPhoto(choices, photo, true));
  const read = parseDebugExport(await (await debugExportFile(exported, false)).text());
  assert.equal(replayDebugExport(read).kind, "reproduced");
  assert.equal(read.checkpoint?.snapshot.stageImage, photo);
  assert.deepEqual(
    read.photos.map((each) => [each.reference, each.data]),
    [[photo, PNG]],
  );
});

test("an image that never became the preview can be dropped, and Use image answers only with a stored image", async (context) => {
  stubBrowser(context);
  const scope = effectScope();
  const host = scope.run(() =>
    usePlayerSession({
      bridge: inProcessBackend(),
      decodeImage: async () => ({ width: 1, height: 1 }),
    }),
  );
  assert.ok(host);
  context.after(() => scope.stop());
  host.prepare(await sourceStart(host.bridge, "let pick = askImage()\nshowImage pick\nexit"));
  await host.activate();
  const reference = await chosen(host, "late.png");
  host.images.discard(reference);
  assert.equal(host.resolveAsset(reference), null);
  // The runtime admits only an image the store holds, also when a dropped one is offered as the preview.
  assert.equal(host.imageCapture.choose(reference), true);
  const result = await answerWith(host, host.imageCapture.answer("button"));
  assert.equal(result.outcome?.kind, "invalidPayload");
  assert.equal(playerRuntimeForeground(host.session.value!)?.kind, "ask-image");
});

test("each image request that allows only the camera is reported as a Player notice while it waits", async (context) => {
  stubBrowser(context);
  const scope = effectScope();
  const host = scope.run(() => usePlayerSession({ bridge: inProcessBackend() }));
  assert.ok(host);
  context.after(() => scope.stop());
  const keys = () => host.notices.value.map((notice) => notice.key);
  const cameraOnly =
    'timer async 2 s {\n  let late = askImage("Timer", allowFile: false)\n}\nlet pick = askImage(allowFile: false)\nexit';
  host.prepare(await sourceStart(host.bridge, cameraOnly));
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
  host.prepare(await sourceStart(host.bridge, cameraOnly));
  await host.activate();
  await until(
    () => keys().includes("image-needs-camera"),
    "the new run's request was not reported",
  );
  const message = () =>
    host.notices.value.find((notice) => notice.key === "image-needs-camera")?.message;
  assert.equal(message(), "This image request needs a camera, which cannot be used here.");
  // A request the player may skip can still be answered, which the notice says.
  host.prepare(
    await sourceStart(host.bridge, "let pick = askImage(allowFile: false, allowSkip: true)\nexit"),
  );
  await host.activate();
  await until(
    () => message() === "The camera cannot be used here. Choose Skip to answer without an image.",
    "the skippable request's notice does not name Skip",
  );
  // A new session without such a request withdraws it.
  host.prepare(await sourceStart(host.bridge, 'let pick = askImage("Add an image")\nexit'));
  await host.activate();
  await until(() => !keys().includes("image-needs-camera"), "the notice was not withdrawn");
});

test("audio that loaded and then fails while it plays is a 'could not be played' warning, and the script goes on", async (context) => {
  stubBrowser(context);
  const scope = effectScope();
  const host = scope.run(() =>
    usePlayerSession({
      bridge: inProcessBackend(),
      resolveAsset: (path) => (path === "sounds/chime.wav" ? `/files/${path}` : null),
      decodeImage: async () => ({ width: 1, height: 1 }),
    }),
  );
  assert.ok(host);
  context.after(() => scope.stop());
  host.prepare(await sourceStart(host.bridge, 'playAudio "sounds/chime.wav"\nsay "after"\nexit'));
  await host.activate();
  const chime = () => audioElements.find((element) => element.src.endsWith("sounds/chime.wav"));
  await until(() => chime() !== undefined, "the chime did not play");
  // The source loads, then its output fails during playback, as headless Firefox's audio sink does (#2113).
  Object.assign(chime()!, { duration: 10, currentTime: 0 });
  chime()!.dispatchEvent(new Event("loadedmetadata"));
  chime()!.dispatchEvent(new Event("error"));
  await until(
    () =>
      host.session.value?.transcriptEntries.some(
        (entry) => entry.kind === "message" && entry.text === "after",
      ) === true,
    "the blocking play did not end",
  );
  assert.deepEqual(
    host.notices.value.map((notice) => notice.message),
    ["Audio could not be played: sounds/chime.wav (main.tease, line 1)"],
  );
});

test("audio a Continue restores as loaded that then fails while it plays is also 'could not be played'", async (context) => {
  stubBrowser(context);
  const scope = effectScope();
  const host = scope.run(() =>
    usePlayerSession({
      bridge: inProcessBackend(),
      resolveAsset: (path) => (path === "sounds/chime.wav" ? `/files/${path}` : null),
      decodeImage: async () => ({ width: 1, height: 1 }),
    }),
  );
  assert.ok(host);
  context.after(() => scope.stop());
  host.prepare(await sourceStart(host.bridge, 'playAudio "sounds/chime.wav"\nsay "after"\nexit'));
  await host.activate();
  const chime = () => audioElements.findLast((element) => element.src.endsWith("sounds/chime.wav"));
  await until(() => chime() !== undefined, "the chime did not play");
  Object.assign(chime()!, { duration: 10, currentTime: 0 });
  chime()!.dispatchEvent(new Event("loadedmetadata"));
  const loaded = () => playerRuntimeMedia(host.session.value!.state).media[0]?.loaded === true;
  await until(loaded, "the chime's load did not show");
  // A Continue restores the session with the chime already loaded: its new element reports no load of its own.
  host.prepareRestore(shown(host));
  await host.activate();
  await until(
    () => chime()?.src.endsWith("sounds/chime.wav") === true && loaded(),
    "the restored chime did not play",
  );
  Object.assign(chime()!, { duration: 10, currentTime: 0 });
  chime()!.dispatchEvent(new Event("loadedmetadata"));
  chime()!.dispatchEvent(new Event("error"));
  await until(
    () =>
      host.session.value?.transcriptEntries.some(
        (entry) => entry.kind === "message" && entry.text === "after",
      ) === true,
    "the restored blocking play did not end",
  );
  assert.deepEqual(
    host.notices.value.map((notice) => notice.message),
    ["Audio could not be played: sounds/chime.wav (main.tease, line 1)"],
  );
});

test("media the script refers to but the Player cannot use is a warning, once per session and path", async (context) => {
  stubBrowser(context);
  const packageFiles = new Set(["sounds/broken.wav", "videos/intro.mp4"]);
  const scope = effectScope();
  const host = scope.run(() =>
    usePlayerSession({
      bridge: inProcessBackend(),
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
  host.prepare(await sourceStart(host.bridge, script));
  await host.activate();
  // An async play waits for its load: the missing sound is reported while the run waits for the next one.
  await until(() => messages().length === 2, "the missing image and sound were not reported");
  // The missing sound's load report goes over the bridge (L5d) before the script plays the next one.
  const broken = () => audioElements.find((element) => element.src.endsWith("sounds/broken.wav"));
  await until(() => broken() !== undefined, "the broken sound did not play");
  broken()!.dispatchEvent(new Event("error"));
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
  await answer(host, await chosen(host, "photo.png"));
  await nextTick();
  host.stageImageFailure(
    host.resolveAsset(playerRuntimeSnapshot(host.session.value!).stageImage!)!,
  );
  // The same missing image shown again in this session is not reported again.
  await answer(host, await chosen(host, "other.png"));
  await nextTick();
  assert.equal(playerRuntimeSnapshot(host.session.value!).stageImage, "images/missing.png");
  assert.deepEqual(messages(), []);

  // A new session reports it again.
  host.prepare(await sourceStart(host.bridge, script));
  await host.activate();
  await until(() => messages().length === 2, "the new session did not report the missing media");
});

test("a speaker's avatar that is no package file is a warning when a message first shows it, also after input", async (context) => {
  stubBrowser(context);
  const scope = effectScope();
  const host = scope.run(() =>
    usePlayerSession({
      bridge: inProcessBackend(),
      resolveAsset: (path) => (path === "avatars/guide.png" ? `/files/${path}` : null),
    }),
  );
  assert.ok(host);
  context.after(() => scope.stop());
  const messages = () => host.notices.value.map((notice) => notice.message);
  const answer = () => {
    host.update(submitPlayerRuntimeComposer(host.session.value!, "go")!.session);
    return nextTick();
  };
  const script = [
    'speaker guide {\n  displayName: "Guide"\n  avatar: "avatars/guide.png"\n}',
    'speaker helper {\n  displayName: "Helper"\n  avatar: "avatars/missing.png"\n}',
    'say as guide "Hello", instant',
    'let first = askText "Next?"',
    // The speaker the session adds after input, and an avatar changed after input.
    'say as helper "After", instant',
    'say as helper "Again", instant',
    'let second = askText "Next?"',
    'guide.avatar = "avatars/changed.png"',
    'say as guide "Changed", instant',
    'let third = askText "Done?"',
    "exit",
  ].join("\n");
  host.prepare(await sourceStart(host.bridge, script));
  await host.activate();
  await nextTick();
  assert.deepEqual(messages(), []);
  await answer();
  assert.deepEqual(messages(), ["Image not found: avatars/missing.png"]);
  await answer();
  assert.deepEqual(messages(), [
    "Image not found: avatars/missing.png",
    "Image not found: avatars/changed.png",
  ]);
});

test("a package image the Stage cannot load is reported while the Stage shows it", async (context) => {
  stubBrowser(context);
  const scope = effectScope();
  const host = scope.run(() =>
    usePlayerSession({ bridge: inProcessBackend(), resolveAsset: (path) => `/files/${path}` }),
  );
  assert.ok(host);
  context.after(() => scope.stop());
  const script = 'showImage "images/corrupt.png"\nlet pick = askImage()\nexit';
  host.prepare(await sourceStart(host.bridge, script));
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
  host.prepare(await sourceStart(host.bridge, script));
  await host.activate();
  await nextTick();
  assert.deepEqual(
    host.notices.value.map((notice) => notice.message),
    ["Image could not be loaded: images/corrupt.png"],
  );
  // Once the Stage shows another source, such as a development override, the failure no longer describes it.
  host.dismissNotice("unusable-media:images/corrupt.png");
  host.stageImageFailure(null);
  host.prepare(await sourceStart(host.bridge, script));
  await host.activate();
  await nextTick();
  assert.equal(host.notices.value.length, 0);
});

// L5h.3b, the second final review's B2-L-C-D-E: a candidate whose photo read still waits when its activation retires
// is no candidate. Its ticket goes, no read starts after the retirement, and the replacement shows on untouched.
test("a debug export whose photo read waits while a new Start retires its activation hands nothing over", async (context) => {
  stubBrowser(context);
  const scope = effectScope();
  const host = scope.run(() =>
    usePlayerSession({
      bridge: inProcessBackend(),
      decodeImage: async () => ({ width: 1, height: 1 }),
    }),
  )!;
  context.after(() => scope.stop());
  host.prepare(
    await sourceStart(
      host.bridge,
      'let image = askImage("Photo")\nlet second = askImage("Second photo")\nlet name = askText "Name"\nexit',
    ),
  );
  await host.activate();
  await answer(host, await chosen(host, "used.png"));
  await answer(host, await chosen(host, "second.png"));
  const media: Record<string, unknown> = await loadPlayerModule("player/media/captured-media.ts");
  const facade: Record<string, unknown> = await loadPlayerModule(
    "player/engine-bridge/in-process.ts",
  );
  assert.equal(typeof facade.heldTickets, "function");
  // EVIDENCE: validation: the bundle's tickets facade, checked callable above.
  const heldTickets = facade.heldTickets as (bridge: PlayerBridge) => string[];
  // EVIDENCE: validation: the bundle's media store class, whose `read` the candidate's photo reads go through.
  const store = media.CapturedMediaStore as {
    prototype: { read(reference: string): Promise<object | null> };
  };
  const bridge = await host.bridge;
  const read = store.prototype.read;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const state = { reached: false, retired: false };
  const reads: boolean[] = [];
  context.mock.method(store.prototype, "read", async function (this: unknown, reference: string) {
    reads.push(state.retired);
    const record = await read.call(this, reference);
    state.reached = true;
    await gate;
    return record;
  });
  const pending = host.debugExportCandidate(
    () => ({
      player: {},
      host: { stage: { status: "hidden", path: null }, media: [], notices: [], debugLog: null },
    }),
    new AbortController().signal,
  );
  await until(() => state.reached, "the candidate reads its first photo");
  assert.deepEqual(heldTickets(bridge), ["r1"]);
  host.prepare(await sourceStart(host.bridge, 'let next = askText "Replacement"\nexit'));
  await host.activate();
  const replacement = host.session.value;
  state.retired = true;
  open();
  // The composable gives `null` for a candidate it does not hand over.
  const candidate: DebugExportCandidate | null = await pending;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(
    {
      candidate,
      readsAfterRetirement: reads.filter((after) => after).length,
      tickets: heldTickets(bridge),
      replacementShown: host.session.value === replacement,
    },
    { candidate: null, readsAfterRetirement: 0, tickets: [], replacementShown: true },
  );
});

/*
 * L5h.3b, the scoped round after the second final review: a random adoption acts for the activation that shows its
 * session (`adoptRandom`). The real adoption's reply is held at the page's request; a successor activation begins; then
 * the old reply arrives. A success writes nothing over the successor's history revision; a failure stops nothing of
 * it, sets no error and captures nothing. Runs and tickets end empty.
 */
async function heldAdoption(
  context: TestContext,
  before: "start" | "continue",
  outcome: "success" | "failure",
) {
  stubBrowser(context);
  const scope = effectScope();
  const host = scope.run(() => usePlayerSession({ bridge: inProcessBackend() }))!;
  context.after(() => scope.stop());
  const bridge = await host.bridge;
  const facade: Record<string, unknown> = await loadPlayerModule(
    "player/engine-bridge/in-process.ts",
  );
  // EVIDENCE: validation: the bundle's facades, which the assertions below call.
  const { heldRuns, heldTickets } = facade as {
    heldRuns: (bridge: PlayerBridge) => number[];
    heldTickets: (bridge: PlayerBridge) => string[];
  };
  host.setRandomControl({ sites: [] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  if (before === "continue") {
    host.prepare(await sourceStart(host.bridge, 'let restored = askText "Restored"\nexit'));
    await host.activate();
  }
  const request = bridge.client.request.bind(bridge.client);
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const held = { adoption: false };
  const posted: string[] = [];
  context.mock.method(bridge.client, "request", (...args: Parameters<typeof request>) => {
    posted.push(args[0]);
    const answered = request(...args);
    if (args[0] !== "adoptRandom" || held.adoption) return answered;
    held.adoption = true;
    // The host ran the adoption; its reply reaches the page only once the successor began.
    return answered.then(async (reply) => {
      await gate;
      if (outcome === "failure") throw new TypeError("The adoption failed.");
      return reply;
    });
  });
  if (before === "continue") host.prepareRestore(shown(host));
  else host.prepare(await sourceStart(host.bridge, 'let old = askText "Old"\nexit'));
  await host.activate();
  await until(() => held.adoption, "the activation adopts its session");
  host.prepare(await sourceStart(host.bridge, 'let next = askText "Successor"\nexit'));
  await host.activate();
  host.forgetRandomHistory();
  const successor = host.session.value;
  const stateBefore = JSON.stringify(successor?.state);
  await until(() => posted.includes("randomControl"), "the successor's reset is sent");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const revision = host.randomRevision.value;
  const from = posted.length;
  open();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const observed = {
    revision: host.randomRevision.value,
    error: host.hostError.value,
    captures: posted.slice(from).filter((op) => op === "captureRecording").length,
    shown:
      host.session.value === successor && JSON.stringify(host.session.value?.state) === stateBefore,
  };
  scope.stop();
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { observed, revision, runs: heldRuns(bridge), tickets: heldTickets(bridge) };
}

for (const [before, outcome] of [
  ["start", "success"],
  ["start", "failure"],
  ["continue", "failure"],
] as const)
  test(`a ${before}'s random adoption whose ${outcome} arrives after a successor began acts for nothing of it`, async (context) => {
    const { observed, revision, runs, tickets } = await heldAdoption(context, before, outcome);
    // The successor's reset is the history's second revision, after the old adoption's first; it stays.
    assert.deepEqual(
      { revision, observed, runs, tickets },
      {
        revision: 2,
        observed: { revision: 2, error: null, captures: 0, shown: true },
        runs: [],
        tickets: [],
      },
    );
  });

// L5h.3b, the last scoped round: Debug mode's change acts for the activation that showed its session. A Continue keeps
// the session's lineage, so a change whose failure arrives after a Continue began must not stop that Continue.
test("a Debug mode change whose failure arrives after a Continue of the same lineage began stops nothing of it", async (context) => {
  stubBrowser(context);
  const scope = effectScope();
  const host = scope.run(() => usePlayerSession({ bridge: inProcessBackend() }))!;
  context.after(() => scope.stop());
  const bridge = await host.bridge;
  const facade: Record<string, unknown> = await loadPlayerModule(
    "player/engine-bridge/in-process.ts",
  );
  // EVIDENCE: validation: the bundle's facades, which the assertions below call.
  const { heldRuns, heldTickets } = facade as {
    heldRuns: (bridge: PlayerBridge) => number[];
    heldTickets: (bridge: PlayerBridge) => string[];
  };
  host.prepare(await sourceStart(host.bridge, 'let old = askText "Old"\nexit'));
  await host.activate();
  const request = bridge.client.request.bind(bridge.client);
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const held = { completed: false };
  const posted: string[] = [];
  context.mock.method(bridge.client, "request", (...args: Parameters<typeof request>) => {
    posted.push(args[0]);
    const answered = request(...args);
    if (args[0] !== "setDebugMode" || held.completed) return answered;
    // The host ran the change; its failure reaches the page only once the Continue began.
    return answered.then(async () => {
      held.completed = true;
      await gate;
      throw new TypeError("The Debug mode change failed.");
    });
  });
  const identityOf = (session: unknown) => {
    // EVIDENCE: fixture: a host session's publication carries its diagnostic identity and lineage.
    return session as {
      readonly diagnostic: { readonly run: number };
      readonly lineage: string;
    } | null;
  };
  const predecessor = identityOf(host.session.value);
  host.setDebugMode(true);
  await until(() => held.completed, "the host ran the Debug mode change");
  host.prepareRestore(shown(host));
  await host.activate();
  const successor = identityOf(host.session.value);
  const state = JSON.stringify(host.session.value?.state);
  const from = posted.length;
  open();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const observed = {
    runs: [predecessor?.diagnostic.run, successor?.diagnostic.run],
    sameLineage: predecessor?.lineage === successor?.lineage,
    error: host.hostError.value,
    stopped: host.stopped.value,
    captures: posted.slice(from).filter((op) => op === "captureRecording").length,
    sameState: JSON.stringify(host.session.value?.state) === state,
  };
  scope.stop();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(
    { observed, runs: heldRuns(bridge), tickets: heldTickets(bridge) },
    {
      observed: {
        runs: [1, 2],
        sameLineage: true,
        error: null,
        stopped: false,
        captures: 0,
        sameState: true,
      },
      runs: [],
      tickets: [],
    },
  );
});
