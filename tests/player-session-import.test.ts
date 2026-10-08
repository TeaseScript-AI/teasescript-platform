import assert from "node:assert/strict";
import test, { before, type TestContext } from "node:test";
import { effectScope, type Ref } from "vue";
import { createServer } from "vite";

import type { CapturedMediaLocks } from "../player/captured-media-persistence.js";
import {
  createPlayerRuntimeSession,
  pendingPlayerRuntimeStorageWrite,
  type PlayerRuntimeSession,
  type PlayerRuntimeSessionOptions,
} from "../player/runtime-adapter.js";
import type { SavedDataHost } from "../player/saved-data.js";
import { createLocalScriptStorage, type ScriptStorageProvider } from "../player/script-storage.js";
import {
  bundleSavedScripts,
  readStorageTransferFile,
  storageTransferFile,
  type SavedScript,
  type StorageBundle,
  type StorageBundleScript,
} from "../player/storage-transfer.js";
import type { RuntimeScriptStorageEntrySnapshot, SerializableRuntimeValue } from "../src/index.js";
import { FakeMediaRepository } from "./helpers/fake-media-repository.js";

interface ImportScript {
  readonly scope: string;
  readonly name: string | null;
  readonly values: number;
  readonly photos: number;
  readonly currentValues: number;
  readonly shown: boolean;
}
interface ImportReview {
  readonly scripts: readonly ImportScript[];
}
interface ImportHost {
  readonly session: Readonly<Ref<PlayerRuntimeSession | null>>;
  readonly activation: Readonly<Ref<"start" | "continue" | null>>;
  readonly sessionInProgress: Readonly<Ref<boolean>>;
  readonly canImportSavedData: Readonly<Ref<boolean>>;
  savedScripts(): Promise<readonly SavedScript[]>;
  reviewSavedDataImport(bundle: StorageBundle): Promise<ImportReview>;
  importSavedData(review: ImportReview, chosen: ReadonlySet<string>): Promise<void>;
  loadScriptStorage(): Promise<void>;
  scriptStorageOptions(): PlayerRuntimeSessionOptions;
  prepare(create: () => PlayerRuntimeSession): void;
  activate(): Promise<void>;
}
let usePlayerSession: (options: {
  scriptStorage: ScriptStorageProvider;
  capturedMedia: { repository: FakeMediaRepository };
  savedData: SavedDataHost;
  decodeImage: (data: Blob) => Promise<{ width: number; height: number }>;
}) => ImportHost;
let browserSavedData: (
  storage: Storage,
  repository: FakeMediaRepository,
  keptSessions: undefined,
  locks: CapturedMediaLocks,
) => SavedDataHost;

// Load the real Vue composable and saved-data host through the existing build tool, as one module graph: its
// browser-source imports use Vite resolution, and error classes stay one class.
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
    const savedData: Record<string, unknown> = await server.ssrLoadModule("/player/saved-data.ts");
    assert.equal(typeof session.usePlayerSession, "function");
    assert.equal(typeof savedData.browserSavedData, "function");
    // EVIDENCE: validation: Vite loaded the real source module and the export is callable; this is its tested host API.
    usePlayerSession = session.usePlayerSession as typeof usePlayerSession;
    // EVIDENCE: validation: Vite loaded the real source module and the export is callable; this is its tested host API.
    browserSavedData = savedData.browserSavedData as typeof browserSavedData;
  } finally {
    await server.close();
  }
});

// The browser surface the Player host touches without a camera; no Web Locks, so durable writes are not coordinated.
function stubBrowser(context: TestContext) {
  const values = {
    document: new EventTarget(),
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

/** An in-memory provider with an operation log; `beforeWrite` can hold a write. */
class MemoryProvider implements ScriptStorageProvider {
  readonly entries = new Map<string, SerializableRuntimeValue>();
  readonly log: string[] = [];
  beforeWrite: () => Promise<void> = async () => {};
  beforeReplace: () => void = () => {};
  constructor(readonly scope: string) {}
  async load(): Promise<readonly RuntimeScriptStorageEntrySnapshot[]> {
    return [...this.entries].map(([key, value]) => ({ key, value }));
  }
  async write(key: string, value: SerializableRuntimeValue) {
    await this.beforeWrite();
    this.log.push(`write ${key}`);
    if (value === null) this.entries.delete(key);
    else this.entries.set(key, value);
  }
  async replace(entries: readonly RuntimeScriptStorageEntrySnapshot[]) {
    this.beforeReplace();
    this.log.push("replace");
    this.entries.clear();
    for (const { key, value } of entries) this.entries.set(key, value);
  }
  async clear() {
    await this.replace([]);
  }
}

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2]);
const exported = "captured-media:11111111-1111-4111-8111-111111111111:1";
const SHOWN = "development-package:shown";
const OTHER = "development-package:other";
const NEW = "development-package:new";
const idle: CapturedMediaLocks = {
  holdLive: () => ({ granted: Promise.resolve("held"), release: () => {} }),
  whenIdle: async (_scope, work) => (await work(), true),
};

/** A script of a bundle whose values use the exported photo everywhere a reference can be. */
function script(scope: string, name: string | null = null): StorageBundleScript {
  return {
    scope,
    name,
    photos: [exported],
    entries: [
      { key: "photo", value: exported },
      { key: "album", value: { kind: "list", items: [exported, exported, "plain"] } },
      { key: "named", value: { kind: "dict", entries: [{ key: exported, value: "a photo" }] } },
      { key: "score", value: 3 },
    ],
  };
}

function bundle(scripts: StorageBundleScript[], bytes = PNG): StorageBundle {
  return { scripts, images: [{ reference: exported, bytes }] };
}

/** A Player showing the script `SHOWN`, whose storage is `provider`, in a browser that keeps other scripts' data too. */
function createHost(context: TestContext, provider: MemoryProvider) {
  stubBrowser(context);
  const storage = new MemoryStorage();
  const repository = new FakeMediaRepository();
  const savedData = browserSavedData(storage, repository, undefined, idle);
  const decoded: number[] = [];
  const scope = effectScope();
  const host = scope.run(() =>
    usePlayerSession({
      scriptStorage: provider,
      capturedMedia: { repository },
      savedData,
      // Like a browser, which cannot decode an image cut off after its signature.
      decodeImage: async (data) => {
        decoded.push(data.size);
        if (data.size <= 8) throw new Error("truncated image");
        return { width: 2, height: 2 };
      },
    }),
  );
  assert.ok(host);
  context.after(() => scope.stop());
  const other = (scopeName: string) => createLocalScriptStorage(storage, scopeName);
  return { host, repository, decoded, storage, savedData, other };
}

// The composable runs from Vite's module graph, whose error class is another instance than this test's import.
const isTransferError = (error: unknown): error is Error =>
  error instanceof Error && error.name === "StorageTransferError";

async function until(condition: () => boolean, message: string) {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function start(host: ImportHost, source: string) {
  await host.loadScriptStorage();
  host.prepare(() => createPlayerRuntimeSession(source, host.scriptStorageOptions()));
  await host.activate();
}

/** The saved values of a scope as a map. */
async function values(provider: ScriptStorageProvider) {
  return new Map((await provider.load()).map(({ key, value }) => [key, value]));
}

test("export lists every script this browser keeps, the shown one through its own storage", async (context) => {
  const provider = new MemoryProvider(SHOWN);
  provider.entries.set("score", 1);
  const { host, savedData, other } = createHost(context, provider);
  await other(OTHER).replace([{ key: "level", value: 2 }]);
  savedData.rememberName(OTHER, "The Other Script");
  // A script whose saved data was cleared has nothing to export.
  await other(NEW).write("gone", 1);
  await other(NEW).clear();
  const listed = await host.savedScripts();
  assert.deepEqual(
    listed.map(({ script }) => [script.scope, script.name, script.entries.length]),
    [
      [OTHER, "The Other Script", 1],
      [SHOWN, null, 1],
    ],
  );
});

test("a bundle imports each script into its own scope while a different script runs", async (context) => {
  const provider = new MemoryProvider(SHOWN);
  provider.entries.set("kept", 1);
  const { host, repository, other } = createHost(context, provider);
  await other(OTHER).replace([{ key: "old", value: 1 }]);
  await start(host, 'let answer = askText("Waiting")\nexit');

  const review = await host.reviewSavedDataImport(bundle([script(OTHER, "Other"), script(NEW)]));
  assert.deepEqual(
    review.scripts.map((item) => [
      item.scope,
      item.name,
      item.values,
      item.photos,
      item.currentValues,
      item.shown,
    ]),
    [
      [OTHER, "Other", 4, 1, 1, false],
      [NEW, null, 4, 1, 0, false],
    ],
  );
  await host.importSavedData(review, new Set([OTHER, NEW]));

  // The shown script and its session are untouched.
  assert.equal(host.session.value?.state.status, "waiting");
  assert.deepEqual([...provider.entries], [["kept", 1]]);
  // Each script holds the imported values, its photo stored in its own scope under a new reference.
  for (const scope of [OTHER, NEW]) {
    const saved = await values(other(scope));
    const photo = saved.get("photo");
    assert.equal(typeof photo, "string");
    assert.notEqual(photo, exported);
    assert.deepEqual(saved.get("album"), { kind: "list", items: [photo, photo, "plain"] });
    assert.deepEqual(await repository.listReferences(scope), [photo]);
    assert.equal(saved.has("old"), false, "the import replaces, not merges");
  }
});

test("text that names another script's photo stays text when only that script is imported", async (context) => {
  const provider = new MemoryProvider(SHOWN);
  const { host, repository, other } = createHost(context, provider);
  // OTHER saved a photo; NEW holds the same reference as text, with no photo of its own.
  const data = new Blob([PNG], { type: "image/png" });
  await repository.add({
    namespace: OTHER,
    reference: exported,
    kind: "image",
    mimeType: "image/png",
    size: data.size,
    data,
  });
  await other(OTHER).replace([{ key: "photo", value: exported }]);
  await other(NEW).replace([{ key: "note", value: exported }]);
  const listed = await host.savedScripts();
  assert.deepEqual(
    listed.map((saved) => [saved.script.scope, saved.photos.length, saved.missingPhotos]),
    [
      [NEW, 0, 1],
      [OTHER, 1, 0],
    ],
  );
  const file = await storageTransferFile(await bundleSavedScripts(listed), false);
  const read = await readStorageTransferFile(new Uint8Array(await file.arrayBuffer()));
  await other(NEW).replace([{ key: "note", value: "changed" }]);

  const review = await host.reviewSavedDataImport(read);
  assert.deepEqual(
    review.scripts.map((item) => [item.scope, item.photos]),
    [
      [NEW, 0],
      [OTHER, 1],
    ],
  );
  await host.importSavedData(review, new Set([NEW]));
  assert.deepEqual([...(await values(other(NEW)))], [["note", exported]]);
  assert.deepEqual(await repository.listReferences(NEW), []);
  assert.deepEqual(await repository.listReferences(OTHER), [exported]);
});

test("a bundle that includes the shown script ends its session, and the next Start loads its data", async (context) => {
  const provider = new MemoryProvider(SHOWN);
  provider.entries.set("old", 1);
  const { host, repository, other } = createHost(context, provider);
  await start(host, 'let answer = askText("Waiting")\nexit');
  const review = await host.reviewSavedDataImport(bundle([script(SHOWN), script(OTHER)]));
  assert.deepEqual(
    review.scripts.map((item) => [item.scope, item.shown]),
    [
      [SHOWN, true],
      [OTHER, false],
    ],
  );
  const storedBeforeReplace: number[] = [];
  provider.beforeReplace = () => storedBeforeReplace.push(repository.size);
  await host.importSavedData(review, new Set([SHOWN, OTHER]));
  assert.deepEqual(storedBeforeReplace, [1], "the photo is stored before the values");
  assert.equal(host.session.value, null, "the session ended");
  assert.equal(host.activation.value, "start", "Start is offered, not run");
  const photo = provider.entries.get("photo");
  assert.notEqual(photo, exported);
  assert.deepEqual(await repository.listReferences(SHOWN), [photo]);
  assert.equal((await values(other(OTHER))).get("score"), 3);

  // A new session loads the imported values.
  host.prepare(() =>
    createPlayerRuntimeSession(
      'let photo: string = load("photo", default: "")\nsave photo as "copy"\nsave load("score", default: 0) + 1 as "score"\nexit',
      host.scriptStorageOptions(),
    ),
  );
  await host.activate();
  await until(() => host.session.value?.state.status === "halted", "the session did not end");
  assert.equal(provider.entries.get("copy"), photo);
  assert.equal(provider.entries.get("score"), 4);
});

test("unticked scripts keep their saved data, the shown one and its session included", async (context) => {
  const provider = new MemoryProvider(SHOWN);
  provider.entries.set("kept", 1);
  const { host, other } = createHost(context, provider);
  await other(OTHER).replace([{ key: "kept", value: "other" }]);
  await start(host, 'let answer = askText("Waiting")\nexit');
  const review = await host.reviewSavedDataImport(
    bundle([script(SHOWN), script(OTHER), script(NEW)]),
  );
  await host.importSavedData(review, new Set([NEW]));
  assert.equal(host.session.value?.state.status, "waiting");
  assert.deepEqual([...provider.entries], [["kept", 1]]);
  assert.deepEqual([...(await values(other(OTHER)))], [["kept", "other"]]);
  assert.equal((await values(other(NEW))).get("score"), 3);
});

test("a damaged photo refuses the whole import before anything changes", async (context) => {
  const provider = new MemoryProvider(SHOWN);
  provider.entries.set("kept", 1);
  const { host, repository, decoded, other } = createHost(context, provider);
  await other(OTHER).replace([{ key: "kept", value: "other" }]);
  await start(host, 'let answer = askText("Waiting")\nexit');
  for (const [bytes, message] of [
    [Uint8Array.from([1, 2, 3, 4]), /Saved photo 1 is damaged/],
    // A PNG signature, cut off before any image data, that the browser cannot decode.
    [PNG.slice(0, 8), /Saved photo 1 is damaged/],
  ] as const)
    await assert.rejects(
      host.reviewSavedDataImport(bundle([script(SHOWN), script(OTHER)], bytes)),
      (error: unknown) => isTransferError(error) && message.test(error.message),
    );
  // Only the truncated PNG passed sniffing and reached the decoder.
  assert.deepEqual(decoded, [8]);
  assert.ok(host.session.value, "the session continues");
  assert.deepEqual([...provider.entries], [["kept", 1]]);
  assert.deepEqual([...(await values(other(OTHER)))], [["kept", "other"]]);
  assert.equal(repository.size, 0);
  assert.deepEqual(provider.log, []);
});

test("a script whose photos cannot be stored keeps its saved data, and Start is offered again", async (context) => {
  const provider = new MemoryProvider(SHOWN);
  provider.entries.set("kept", 1);
  const { host, repository, other } = createHost(context, provider);
  await other(OTHER).replace([{ key: "kept", value: "other" }]);
  await start(host, 'let answer = askText("Waiting")\nexit');
  const review = await host.reviewSavedDataImport(bundle([script(SHOWN), script(OTHER)]));
  repository.failWrites = true;
  await assert.rejects(
    host.importSavedData(review, new Set([SHOWN, OTHER])),
    (error: unknown) =>
      isTransferError(error) &&
      /development-package:shown \(its photos could not be stored\)/.test(error.message) &&
      /development-package:other \(its photos could not be stored\)/.test(error.message),
  );
  assert.deepEqual([...provider.entries], [["kept", 1]]);
  assert.deepEqual(provider.log, []);
  assert.deepEqual([...(await values(other(OTHER)))], [["kept", "other"]]);
  // The confirmed end of the session stands; the player can start again with the unchanged data.
  assert.equal(host.session.value, null);
  assert.equal(host.activation.value, "start");
  assert.equal(host.canImportSavedData.value, true);
});

test("a save the ended session had issued finishes before the import replaces the data", async (context) => {
  const provider = new MemoryProvider(SHOWN);
  let releaseWrite = () => {};
  provider.beforeWrite = () => new Promise<void>((resolve) => (releaseWrite = resolve));
  const { host } = createHost(context, provider);
  // Reviewed first: reading the saved data waits for issued saves, too.
  await host.loadScriptStorage();
  const review = await host.reviewSavedDataImport(bundle([script(SHOWN)]));
  await start(host, 'save "late" as "late"\nexit');
  await until(
    () =>
      host.session.value !== null &&
      pendingPlayerRuntimeStorageWrite(host.session.value.state) !== null,
    "the save was not requested",
  );
  const importing = host.importSavedData(review, new Set([SHOWN]));
  // No Start can begin while the import runs.
  assert.equal(host.activation.value, null);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(provider.log, []);
  releaseWrite();
  await importing;
  assert.deepEqual(provider.log, ["write late", "replace"]);
  assert.equal(provider.entries.has("late"), false);
  assert.equal(host.session.value, null, "the late write did not continue the ended session");
});
