import assert from "node:assert/strict";
import test, { before, type TestContext } from "node:test";
import { effectScope, type Ref } from "vue";
import { createServer } from "vite";

import {
  createPlayerRuntimeSession,
  pendingPlayerRuntimeStorageWrite,
  type PlayerRuntimeSession,
  type PlayerRuntimeSessionOptions,
} from "../player/runtime-adapter.js";
import type { ScriptStorageProvider } from "../player/script-storage.js";
import type { StorageTransfer } from "../player/storage-transfer.js";
import type { RuntimeScriptStorageEntrySnapshot, SerializableRuntimeValue } from "../src/index.js";
import { FakeMediaRepository } from "./helpers/fake-media-repository.js";

interface ImportReview {
  readonly currentCount: number;
  readonly removedKeys: readonly string[];
}
interface ImportHost {
  readonly session: Readonly<Ref<PlayerRuntimeSession | null>>;
  readonly activation: Readonly<Ref<"start" | "continue" | null>>;
  readonly sessionInProgress: Readonly<Ref<boolean>>;
  readonly canImportScriptStorage: Readonly<Ref<boolean>>;
  reviewScriptStorageImport(transfer: StorageTransfer): Promise<ImportReview>;
  importScriptStorage(review: ImportReview): Promise<void>;
  loadScriptStorage(): Promise<void>;
  scriptStorageOptions(): PlayerRuntimeSessionOptions;
  prepare(create: () => PlayerRuntimeSession): void;
  activate(): Promise<void>;
}
let usePlayerSession: (options: {
  scriptStorage: ScriptStorageProvider;
  capturedMedia: { repository: FakeMediaRepository };
  decodeImage: (data: Blob) => Promise<{ width: number; height: number }>;
}) => ImportHost;

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

function transfer(scope: string, bytes = PNG): StorageTransfer {
  return {
    scope,
    entries: [
      { key: "photo", value: exported },
      { key: "album", value: { kind: "list", items: [exported, exported, "plain"] } },
      { key: "named", value: { kind: "dict", entries: [{ key: exported, value: "a photo" }] } },
      { key: "score", value: 3 },
    ],
    images: [{ reference: exported, bytes }],
  };
}

function createHost(context: TestContext, provider: MemoryProvider) {
  stubBrowser(context);
  const repository = new FakeMediaRepository();
  const scope = effectScope();
  const host = scope.run(() =>
    usePlayerSession({
      scriptStorage: provider,
      capturedMedia: { repository },
      // Like a browser, only images decode.
      decodeImage: async (data) => {
        const header = new Uint8Array(await data.slice(0, 8).arrayBuffer());
        if (header[1] !== 0x50) throw new Error("not an image");
        return { width: 2, height: 2 };
      },
    }),
  );
  assert.ok(host);
  context.after(() => scope.stop());
  return { host, repository };
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

test("an import ends the running session, stores its photos under new references first, and the next Start loads it", async (context) => {
  const provider = new MemoryProvider("script");
  provider.entries.set("old", 1);
  provider.entries.set("photo", "before");
  const { host, repository } = createHost(context, provider);
  await start(host, 'let answer = askText("Waiting")\nexit');
  assert.equal(host.sessionInProgress.value, true);

  const review = await host.reviewScriptStorageImport(transfer("script"));
  assert.equal(review.currentCount, 2);
  assert.deepEqual(review.removedKeys, ["old"]);
  // Reviewing changes nothing.
  assert.ok(host.session.value);
  assert.deepEqual([...provider.entries.keys()], ["old", "photo"]);

  const storedBeforeReplace: number[] = [];
  provider.beforeReplace = () => storedBeforeReplace.push(repository.size);
  await host.importScriptStorage(review);
  assert.deepEqual(storedBeforeReplace, [1], "the photo is stored before the values");
  assert.equal(host.session.value, null, "the session ended");
  assert.equal(host.sessionInProgress.value, false);
  assert.equal(host.activation.value, "start", "Start is offered, not run");

  // The imported photo has a new reference, everywhere a value held the old one, and other text is kept.
  const photo = provider.entries.get("photo");
  assert.equal(typeof photo, "string");
  assert.notEqual(photo, exported);
  assert.deepEqual(await repository.listReferences("script"), [photo]);
  assert.deepEqual(provider.entries.get("album"), { kind: "list", items: [photo, photo, "plain"] });
  assert.deepEqual(provider.entries.get("named"), {
    kind: "dict",
    entries: [{ key: photo, value: "a photo" }],
  });
  assert.deepEqual([...provider.entries.keys()], ["photo", "album", "named", "score"]);

  // A new session loads the imported values.
  host.prepare(() =>
    createPlayerRuntimeSession(
      'let photo: string = load("photo")\nsave photo as "copy"\nsave load("score", default: 0) + 1 as "score"\nexit',
      host.scriptStorageOptions(),
    ),
  );
  await host.activate();
  await until(() => host.session.value?.snapshot.status === "halted", "the session did not end");
  assert.equal(provider.entries.get("copy"), photo);
  assert.equal(provider.entries.get("score"), 4);
});

test("an import is refused before anything changes for another script's data or a damaged photo", async (context) => {
  const provider = new MemoryProvider("script");
  provider.entries.set("kept", 1);
  const { host, repository } = createHost(context, provider);
  await start(host, 'let answer = askText("Waiting")\nexit');
  const refusals: [StorageTransfer, RegExp][] = [
    [transfer("another script"), /belongs to another script/],
    [transfer("script", Uint8Array.from([1, 2, 3, 4])), /Saved photo 1 is damaged/],
    // A PNG signature the browser cannot decode.
    [
      transfer("script", Uint8Array.from([0x89, 0x51, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
      /Saved photo 1 is damaged/,
    ],
  ];
  for (const [incoming, message] of refusals) {
    await assert.rejects(
      host.reviewScriptStorageImport(incoming),
      (error: unknown) => isTransferError(error) && message.test(error.message),
    );
  }
  assert.ok(host.session.value, "the session continues");
  assert.deepEqual([...provider.entries], [["kept", 1]]);
  assert.equal(repository.size, 0);
  assert.deepEqual(provider.log, []);
});

test("an import whose photos cannot be stored keeps the saved data, and Start is offered again", async (context) => {
  const provider = new MemoryProvider("script");
  provider.entries.set("kept", 1);
  const { host, repository } = createHost(context, provider);
  await start(host, 'let answer = askText("Waiting")\nexit');
  const review = await host.reviewScriptStorageImport(transfer("script"));
  repository.failWrites = true;
  await assert.rejects(
    host.importScriptStorage(review),
    (error: unknown) => isTransferError(error) && /photos could not be stored/.test(error.message),
  );
  assert.deepEqual([...provider.entries], [["kept", 1]]);
  assert.deepEqual(provider.log, []);
  // The confirmed end of the session stands; the player can start again with the unchanged data.
  assert.equal(host.session.value, null);
  assert.equal(host.activation.value, "start");
  assert.equal(host.canImportScriptStorage.value, true);
});

test("a save the ended session had issued finishes before the import replaces the data", async (context) => {
  const provider = new MemoryProvider("script");
  let releaseWrite = () => {};
  provider.beforeWrite = () => new Promise<void>((resolve) => (releaseWrite = resolve));
  const { host } = createHost(context, provider);
  // Reviewed first: reading the saved data waits for issued saves, too.
  await host.loadScriptStorage();
  const review = await host.reviewScriptStorageImport(transfer("script"));
  await start(host, 'save "late" as "late"\nexit');
  await until(
    () =>
      host.session.value !== null &&
      pendingPlayerRuntimeStorageWrite(host.session.value.snapshot) !== null,
    "the save was not requested",
  );
  const importing = host.importScriptStorage(review);
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
