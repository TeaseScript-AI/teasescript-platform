import assert from "node:assert/strict";
import test, { before, type TestContext } from "node:test";
import { effectScope, type Ref } from "vue";

import type { CapturedMediaLocks } from "../player/media/captured-media-persistence.js";
import {
  memoryKeptRoomStore,
  memoryKeptSessionStore,
  type KeptRoomStore,
  type KeptSessionStore,
} from "../player/persistence/kept-sessions.js";
import type {
  PlayerRuntimeSession,
  PlayerRuntimeSessionOptions,
} from "../player/runtime/runtime-adapter.js";
import {
  compilePlayerProject,
  createPlayerRuntimeSession,
} from "../player/runtime/compile-project.js";
import { preparedPlan } from "./helpers/prepared-plan.js";
import type { PlayerBridge } from "../player/runtime/player-bridge.js";
import type { SavedDataHost } from "../player/persistence/saved-data.js";
import {
  createLocalScriptStorage,
  type ScriptStorageProvider,
} from "../player/persistence/script-storage.js";
import type { SessionTransfer } from "../player/persistence/session-transfer.js";
import type { StorageBundle, StorageBundleScript } from "../player/persistence/storage-transfer.js";
import { FakeMediaRepository } from "./helpers/player/fake-media-repository.js";
import { loadPlayerModule } from "./helpers/player-modules.js";
import { answerWith, type Intent } from "./helpers/player-input.js";
import { loadHostFacade } from "./helpers/host-sessions.js";
import { readForImport, type SessionRead } from "./helpers/transfer-read.js";

// The kept session's lifecycle around its preparation and the saved-data import (#1862, #1863): a preparation that
// something later replaced shows nothing and puts back no photo, and an import replaces a script's values only once
// its kept session is gone. Reads are held in the stores, as an IndexedDB read issued before a later write is answered
// after it; a fresh page of the same browser shows what a reload would continue.

/** The host's reviews, as these tests pass them back unread. */
interface SavedDataImportReview {
  readonly scripts: readonly { readonly scope: string }[];
}
interface SessionImportReview {
  readonly currentValues: number;
}
interface Host {
  readonly session: Readonly<Ref<PlayerRuntimeSession | null>>;
  readonly activation: Readonly<Ref<"start" | "continue" | null>>;
  readonly rooms: {
    readonly current: Readonly<Ref<"normal" | "debug">>;
    resetDebug(): Promise<void>;
  };
  readonly images: {
    store(
      file: File,
      filters: { types: readonly string[] | null; mime: readonly string[] | null },
    ): Promise<{ readonly reference: string } | { readonly message: string }>;
  };
  readonly imageCapture: { choose(reference: string): boolean; answer(input: "button"): Intent };
  loadScriptStorage(): Promise<void>;
  scriptStorageOptions(): PlayerRuntimeSessionOptions;
  readonly bridge: Promise<PlayerBridge>;
  prepareScript(
    plan: string,
    create: (options: PlayerRuntimeSessionOptions) => PlayerRuntimeSession,
  ): Promise<void>;
  prepare(create: () => PlayerRuntimeSession): void;
  activate(): Promise<void>;
  update(session: PlayerRuntimeSession): void;
  readonly inputSection: unknown;
  toStartPage(): Promise<void>;
  setDebugMode(enabled: boolean): void;
  resolveAsset(path: string): string | null;
  reviewSavedDataImport(bundle: StorageBundle): Promise<SavedDataImportReview>;
  importSavedData(review: SavedDataImportReview, chosen: ReadonlySet<string>): Promise<void>;
  exportSession(): Promise<{ readonly transfer: SessionTransfer }>;
  readTransfer(input: {
    readonly bytes: Uint8Array<ArrayBuffer>;
  }): Promise<{ readonly kind: string }>;
  reviewSessionImport(transfer: SessionRead): Promise<SessionImportReview>;
  importSession(review: SessionImportReview): Promise<void>;
}
let usePlayerSession: (options: {
  scriptStorage: ScriptStorageProvider;
  capturedMedia: { repository: FakeMediaRepository };
  keptSessions: KeptSessionStore;
  debugRooms: KeptRoomStore;
  savedData: SavedDataHost;
  room?: "debug";
  decodeImage: (data: Blob) => Promise<{ width: number; height: number }>;
}) => Host;
let browserSavedData: (
  storage: Storage,
  repository: FakeMediaRepository,
  keptSessions: KeptSessionStore,
  locks: CapturedMediaLocks,
) => SavedDataHost;

before(async () => {
  await loadHostFacade();
  const session: Record<string, unknown> = await loadPlayerModule(
    "player/vue/src/session/usePlayerSession.ts",
  );
  const saved: Record<string, unknown> = await loadPlayerModule("player/persistence/saved-data.ts");
  assert.equal(typeof session.usePlayerSession, "function");
  assert.equal(typeof saved.browserSavedData, "function");
  // EVIDENCE: validation: Vite loaded the real source module and the export is callable; this is its tested host API.
  usePlayerSession = session.usePlayerSession as typeof usePlayerSession;
  // EVIDENCE: validation: Vite loaded the real source module and the export is callable; this is its tested host API.
  browserSavedData = saved.browserSavedData as typeof browserSavedData;
});

function stubBrowser(context: TestContext) {
  const values = {
    document: Object.assign(new EventTarget(), { visibilityState: "visible" }),
    window: new EventTarget(),
    navigator: {},
    Audio: class extends EventTarget {
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

/** Browser local storage in memory. */
class MemoryStorage implements Storage {
  private readonly items = new Map<string, string>();
  get length(): number {
    return this.items.size;
  }
  clear(): void {
    this.items.clear();
  }
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.items.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
}

/** Holds the next answer it passes once armed, until released, as storage answering a read after later writes. */
class Hold {
  #armed = false;
  #held: (() => void)[] = [];
  reached = 0;
  arm() {
    this.#armed = true;
  }
  async pass<T>(value: T): Promise<T> {
    if (!this.#armed) return value;
    this.#armed = false;
    this.reached++;
    await new Promise<void>((resolve) => this.#held.push(resolve));
    return value;
  }
  release() {
    for (const resolve of this.#held.splice(0)) resolve();
  }
}

const SHOWN = "development-package:shown";
const OTHER = "development-package:other";
const NEW = "development-package:new";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const idle: CapturedMediaLocks = {
  holdLive: () => ({ granted: Promise.resolve("held"), release: () => {} }),
  whenIdle: async (_scope, work) => (await work(), true),
};
const PLAN = compilePlayerProject(
  'let score: number = load("score", default: 0)\nlet first = askText("First ${score}")\nlet second = askText("Second ${score}")\nexit',
).plan!;
const PHOTO = compilePlayerProject(
  'let score: number = load("score", default: 0)\nlet picture: string = askImage(hint: "Add an image")\nlet first = askText("First ${score}")\nexit',
).plan!;
const ENDS = compilePlayerProject(
  'let score: number = load("score", default: 0)\nsay "Done ${score}", instant\nexit',
).plan!;
const OTHER_START = compilePlayerProject('let other = askText("Other")\nexit').plan!;

/**
 * One browser: every script's saved values (score 1 each), photos, kept sessions and debug rooms. Reads of a kept
 * session, a debug room's session, and a kept photo can be held; `refused` scopes' kept sessions cannot be discarded.
 */
async function browser() {
  const storage = new MemoryStorage();
  const repository = new FakeMediaRepository();
  const innerKept = memoryKeptSessionStore();
  const innerRooms = memoryKeptRoomStore();
  const holds = { session: new Hold(), room: new Hold(), photo: new Hold() };
  const refused = new Set<string>();
  const kept: KeptSessionStore = {
    ...innerKept,
    session: async (scope) => holds.session.pass(await innerKept.session(scope)),
    media: {
      ...innerKept.media,
      get: async (scope, reference) =>
        holds.photo.pass(await innerKept.media.get(scope, reference)),
    },
    async discard(scope) {
      if (refused.has(scope)) throw new DOMException("The storage is full.", "QuotaExceededError");
      return innerKept.discard(scope);
    },
  };
  const rooms: KeptRoomStore = {
    ...innerRooms,
    session: async (scope) => holds.room.pass(await innerRooms.session(scope)),
  };
  const provider = (scope: string) => createLocalScriptStorage(storage, scope);
  for (const scope of [SHOWN, OTHER, NEW]) await provider(scope).write("score", 1);
  const savedData = browserSavedData(storage, repository, kept, idle);
  return { repository, innerKept, innerRooms, kept, rooms, holds, refused, provider, savedData };
}
type Browser = Awaited<ReturnType<typeof browser>>;

/** A page of the Player in `at`, showing the script of `scope`, in the normal room or its debug room. */
function page(context: TestContext, at: Browser, options: { scope?: string; room?: "debug" } = {}) {
  const scope = effectScope();
  const host = scope.run(() =>
    usePlayerSession({
      scriptStorage: at.provider(options.scope ?? SHOWN),
      capturedMedia: { repository: at.repository },
      keptSessions: at.kept,
      debugRooms: at.rooms,
      savedData: at.savedData,
      ...(options.room === undefined ? {} : { room: options.room }),
      decodeImage: async () => ({ width: 2, height: 2 }),
    }),
  );
  assert.ok(host);
  context.after(() => scope.stop());
  return { host, close: () => scope.stop() };
}

/** The token under which `host`'s bridge holds `plan`, prepared there from its text as a host does. */
const token = (host: Host, plan = PLAN) => preparedPlan(host.bridge, plan);
/** Prepares the held plan `held`, of the test plan `plan`, at once: `prepareScript`'s ownership begins with the call. */
const prepare = (host: Host, held: string, plan = PLAN) =>
  host.prepareScript(held, (options) =>
    createPlayerRuntimeSession(plan, { ...options, ...host.scriptStorageOptions() }),
  );

async function until(condition: () => boolean | Promise<boolean>, message: string) {
  const deadline = Date.now() + 2_000;
  while (!(await condition())) {
    assert.ok(Date.now() < deadline, message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
/** Lets work a released read resumed run to its end. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const said = (host: Host) =>
  host.session.value?.transcriptEntries.map((entry) => entry.text).join(" | ") ?? "";
const values = async (at: Browser, scope: string) =>
  new Map((await at.provider(scope).load()).map(({ key, value }) => [key, value]));

/** Starts the script in a page of its own and keeps its session at the first question; the page then closes. */
async function keepAtFirst(
  context: TestContext,
  at: Browser,
  options: { scope?: string; room?: "debug" } = {},
) {
  const { host, close } = page(context, at, options);
  await host.loadScriptStorage();
  await prepare(host, await token(host));
  assert.equal(host.activation.value, "start");
  await host.activate();
  const store = options.room === "debug" ? at.innerRooms : at.innerKept;
  await until(
    async () => (await store.session(options.scope ?? SHOWN)) !== null,
    "the session was not kept",
  );
  close();
}

/** A page whose kept-session read is held: it shows nothing until `release`. */
async function heldPage(
  context: TestContext,
  at: Browser,
  hold: Hold,
  options: { room?: "debug" } = {},
) {
  const opened = page(context, at, options);
  await opened.host.loadScriptStorage();
  const reached = hold.reached;
  hold.arm();
  const preparing = prepare(opened.host, await token(opened.host));
  await until(() => hold.reached > reached, "the read was not issued");
  assert.equal(opened.host.activation.value, null);
  return { ...opened, preparing };
}

/** What a fresh page of the browser offers, and what its session shows once Start or Continue ran. */
async function fresh(context: TestContext, at: Browser, scope = SHOWN) {
  const { host, close } = page(context, at, { scope });
  await host.loadScriptStorage();
  await prepare(host, await token(host));
  const offered = host.activation.value;
  await host.activate();
  await until(() => said(host).includes("First"), "the fresh page showed nothing");
  // The question the session waits at, with the score it loaded.
  const shown = host.session
    .value!.transcriptEntries.map((entry) => entry.text)
    .find((text) => text.startsWith("First"));
  close();
  return { offered, shown };
}

const savedBundle = (...scopes: string[]): StorageBundle => ({
  scripts: scopes.map((scope): StorageBundleScript => ({
    scope,
    name: null,
    photos: [],
    entries: [{ key: "score", value: 7 }],
  })),
  images: [],
});
const importSaved = async (host: Host, chosen: string[], bundled = chosen) =>
  host.importSavedData(await host.reviewSavedDataImport(savedBundle(...bundled)), new Set(chosen));

test("a kept-session read answered after the shown script's saved-data import offers Start with the imported values", async (context) => {
  stubBrowser(context);
  // Answered before the import, the read offers Continue, which the import then ends.
  const before = await browser();
  await keepAtFirst(context, before);
  const control = await heldPage(context, before, before.holds.session);
  before.holds.session.release();
  await control.preparing;
  assert.equal(control.host.activation.value, "continue");
  await importSaved(control.host, [SHOWN]);
  assert.equal(control.host.activation.value, "start");

  const at = await browser();
  await keepAtFirst(context, at);
  const { host, preparing } = await heldPage(context, at, at.holds.session);
  await importSaved(host, [SHOWN]);
  assert.equal(host.activation.value, "start");
  at.holds.session.release();
  await preparing;
  await settle();
  assert.equal(host.activation.value, "start", "the replaced read offered its Continue");
  // A reload offers Start too; it is checked before this page's Start keeps a session of its own.
  assert.deepEqual(await fresh(context, at), { offered: "start", shown: "First 7" });
  await host.activate();
  await until(() => said(host).includes("First"), "Start did not run");
  assert.match(said(host), /First 7/u);
});

test("a kept photo read answered after the import is not put back, and one answered before is", async (context) => {
  stubBrowser(context);
  /** Keeps a session of `PHOTO` at its question after the photo; resolves to the photo's reference. */
  async function keepPhoto(at: Browser): Promise<string> {
    const { host, close } = page(context, at);
    await host.loadScriptStorage();
    await prepare(host, await token(host, PHOTO), PHOTO);
    await host.activate();
    await until(() => host.session.value?.state.status === "waiting", "the session did not ask");
    const stored = await host.images.store(new File([PNG], "photo.png"), {
      types: null,
      mime: null,
    });
    assert.ok("reference" in stored);
    assert.equal(host.imageCapture.choose(stored.reference), true);
    const used = await answerWith(host, host.imageCapture.answer("button"));
    assert.equal(used.outcome?.kind, "completed");
    await until(
      async () => (await at.innerKept.media.listReferences(SHOWN)).includes(stored.reference),
      "the photo was not kept with the session",
    );
    close();
    return stored.reference;
  }
  async function heldPhotoPage(at: Browser) {
    const opened = page(context, at);
    await opened.host.loadScriptStorage();
    at.holds.photo.arm();
    const preparing = prepare(opened.host, await token(opened.host, PHOTO), PHOTO);
    await until(() => at.holds.photo.reached === 1, "the photo was not read");
    return { ...opened, preparing };
  }

  const before = await browser();
  const shownBefore = await keepPhoto(before);
  const control = await heldPhotoPage(before);
  before.holds.photo.release();
  await control.preparing;
  assert.equal(control.host.activation.value, "continue");
  assert.notEqual(control.host.resolveAsset(shownBefore), null, "the Continue's photo is not back");

  const at = await browser();
  const reference = await keepPhoto(at);
  const { host, preparing } = await heldPhotoPage(at);
  await importSaved(host, [SHOWN]);
  at.holds.photo.release();
  await preparing;
  await settle();
  assert.equal(host.activation.value, "start");
  assert.equal(host.resolveAsset(reference), null, "the replaced session's photo was put back");
});

test("a prepared script that a newer Start replaced while the host got ready offers that Start", async (context) => {
  stubBrowser(context);
  const at = await browser();
  await keepAtFirst(context, at);
  const { host } = page(context, at);
  await host.loadScriptStorage();
  const preparing = prepare(host, await token(host));
  host.prepare(() => createPlayerRuntimeSession(OTHER_START, host.scriptStorageOptions()));
  await preparing;
  await settle();
  assert.equal(host.activation.value, "start");
  await host.activate();
  await until(() => said(host).includes("Other"), "the newer Start did not run");
});

test("a kept-session read answered after a session import leaves the imported session's Continue", async (context) => {
  stubBrowser(context);
  // The exported session read score 5; this browser's own kept session read score 1.
  const elsewhere = await browser();
  await elsewhere.provider(SHOWN).write("score", 5);
  await keepAtFirst(context, elsewhere);
  const exporting = page(context, elsewhere);
  await exporting.host.loadScriptStorage();
  await prepare(exporting.host, await token(exporting.host));
  const { transfer } = await exporting.host.exportSession();

  const at = await browser();
  await keepAtFirst(context, at);
  const { host, preparing } = await heldPage(context, at, at.holds.session);
  await host.importSession(await host.reviewSessionImport(await readForImport(host, transfer)));
  at.holds.session.release();
  await preparing;
  await settle();
  assert.equal(host.activation.value, "continue");
  await host.activate();
  await until(() => said(host).includes("First"), "Continue did not run");
  assert.match(said(host), /First 5/u, "the replaced read's session took the imported one's place");
  assert.deepEqual(await fresh(context, at), { offered: "continue", shown: "First 5" });
});

test("a debug-room read answered after Reset leaves the new debug session running", async (context) => {
  stubBrowser(context);
  const at = await browser();
  await keepAtFirst(context, at, { room: "debug" });
  const { host, preparing } = await heldPage(context, at, at.holds.room, { room: "debug" });
  await host.rooms.resetDebug();
  await until(() => said(host).includes("First"), "the new debug session did not run");
  at.holds.room.release();
  await preparing;
  await settle();
  assert.equal(host.activation.value, null, "the replaced read offered its Continue");
  assert.equal(host.session.value?.state.status, "waiting");
});

test("a normal kept-session read answered after Debug went on offers no normal Continue in the debug room", async (context) => {
  stubBrowser(context);
  const at = await browser();
  await keepAtFirst(context, at);
  const { host, preparing } = await heldPage(context, at, at.holds.session);
  host.setDebugMode(true);
  await until(
    () => host.rooms.current.value === "debug" && host.activation.value === "start",
    "the debug room did not offer Start",
  );
  at.holds.session.release();
  await preparing;
  await settle();
  assert.equal(
    host.activation.value,
    "start",
    "the normal room's Continue showed in the debug room",
  );
});

test("the start page's own read offers Start, and a read answered after unmount prepares nothing", async (context) => {
  stubBrowser(context);
  const at = await browser();
  const { host } = page(context, at);
  await host.loadScriptStorage();
  await prepare(host, await token(host, ENDS), ENDS);
  await host.activate();
  await until(() => host.session.value?.state.status === "halted", "the session did not end");
  at.holds.session.arm();
  const returning = host.toStartPage();
  await until(() => at.holds.session.reached === 1, "the start page did not read");
  at.holds.session.release();
  await returning;
  assert.equal(host.activation.value, "start");

  await keepAtFirst(context, at);
  const closing = await heldPage(context, at, at.holds.session);
  closing.close();
  at.holds.session.release();
  await closing.preparing;
  await settle();
  assert.equal(closing.host.activation.value, null);
});

test("a saved-data import whose kept session cannot be discarded leaves the script's data, and a reload continues it", async (context) => {
  stubBrowser(context);
  for (const refuse of [false, true]) {
    const at = await browser();
    await keepAtFirst(context, at);
    const { host } = page(context, at);
    await host.loadScriptStorage();
    await prepare(host, await token(host));
    assert.equal(host.activation.value, "continue");
    if (refuse) at.refused.add(SHOWN);
    const outcome = await importSaved(host, [SHOWN]).then(
      () => null,
      (error: Error) => error.message,
    );
    at.refused.clear();
    if (!refuse) {
      assert.equal(outcome, null);
      assert.equal((await values(at, SHOWN)).get("score"), 7);
      assert.deepEqual(await fresh(context, at), { offered: "start", shown: "First 7" });
      continue;
    }
    assert.match(
      outcome ?? "",
      new RegExp(`^Not imported, and their saved data is unchanged: ${SHOWN} `, "u"),
    );
    assert.equal((await values(at, SHOWN)).get("score"), 1);
    assert.deepEqual(await fresh(context, at), { offered: "continue", shown: "First 1" });
  }
});

test("among several scripts only the one whose kept session cannot be discarded keeps its data; unchosen ones keep theirs and their sessions", async (context) => {
  stubBrowser(context);
  const at = await browser();
  for (const scope of [SHOWN, OTHER, NEW]) await keepAtFirst(context, at, { scope });
  const { host } = page(context, at);
  await host.loadScriptStorage();
  await prepare(host, await token(host));
  at.refused.add(OTHER);
  const outcome = await importSaved(host, [SHOWN, OTHER], [SHOWN, OTHER, NEW]).then(
    () => "",
    (error: Error) => error.message,
  );
  at.refused.clear();
  assert.match(outcome, new RegExp(`unchanged: ${OTHER} \\(`, "u"));
  assert.doesNotMatch(outcome, new RegExp(`${SHOWN}|${NEW}`, "u"));
  assert.deepEqual(await fresh(context, at, SHOWN), { offered: "start", shown: "First 7" });
  for (const scope of [OTHER, NEW]) {
    assert.equal((await values(at, scope)).get("score"), 1, scope);
    assert.notEqual(await at.innerKept.session(scope), null, scope);
  }
});

test("the debug room imports the script's own saved data only once its kept session is gone, and keeps its own session", async (context) => {
  stubBrowser(context);
  for (const refuse of [false, true]) {
    const at = await browser();
    await keepAtFirst(context, at);
    await keepAtFirst(context, at, { room: "debug" });
    const { host } = page(context, at, { room: "debug" });
    await host.loadScriptStorage();
    await prepare(host, await token(host));
    assert.equal(host.activation.value, "continue");
    if (refuse) at.refused.add(SHOWN);
    const outcome = await importSaved(host, [SHOWN]).then(
      () => null,
      (error: Error) => error.message,
    );
    at.refused.clear();
    assert.equal(outcome === null, !refuse, String(outcome));
    assert.equal((await values(at, SHOWN)).get("score"), refuse ? 1 : 7);
    assert.deepEqual(
      await fresh(context, at),
      refuse ? { offered: "continue", shown: "First 1" } : { offered: "start", shown: "First 7" },
    );
    assert.notEqual(await at.innerRooms.session(SHOWN), null, "the debug room's session went");
  }
});
