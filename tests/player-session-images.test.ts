import assert from "node:assert/strict";
import test, { before, type TestContext } from "node:test";
import { effectScope, type Ref } from "vue";
import { createServer } from "vite";

import {
  answerPlayerRuntimeImage,
  createPlayerRuntimeSession,
  playerRuntimeForeground,
  type PlayerRuntimeSession,
  type PlayerRuntimeSessionOptions,
} from "../player/runtime-adapter.js";
import type { ScriptStorageProvider } from "../player/script-storage.js";
import type { CapturedMediaAdmission, SerializableRuntimeValue } from "../src/index.js";
import { FakeMediaRepository } from "./helpers/fake-media-repository.js";

interface ImageHost {
  readonly session: Readonly<Ref<PlayerRuntimeSession | null>>;
  readonly notices: Readonly<Ref<readonly { readonly key: string }[]>>;
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
  prepare(create: () => PlayerRuntimeSession): void;
  activate(): Promise<void>;
  update(session: PlayerRuntimeSession): void;
}
let usePlayerSession: (options: {
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

// The browser surface the Player host touches without a camera; no Web Locks, so durable writes are not coordinated.
function stubBrowser(context: TestContext) {
  const values = {
    document: new EventTarget(),
    window: new EventTarget(),
    navigator: {},
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
  await until(() => host.session.value?.snapshot.status === "halted", "the save was not serviced");

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

test("an image request that allows only the camera is reported as a Player notice while it waits", async (context) => {
  stubBrowser(context);
  const scope = effectScope();
  const host = scope.run(() => usePlayerSession({}));
  assert.ok(host);
  context.after(() => scope.stop());
  const keys = () => host.notices.value.map((notice) => notice.key);
  host.prepare(() => createPlayerRuntimeSession("let pick = askImage(allowFile: false)\nexit"));
  await host.activate();
  await until(() => keys().includes("image-needs-camera"), "the notice was not published");
  // A new session without such a request withdraws it.
  host.prepare(() => createPlayerRuntimeSession('let pick = askImage("Add an image")\nexit'));
  await host.activate();
  await until(() => !keys().includes("image-needs-camera"), "the notice was not withdrawn");
});
