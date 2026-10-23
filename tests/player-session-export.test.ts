import assert from "node:assert/strict";
import test, { before, type TestContext } from "node:test";
import { effectScope, type Ref } from "vue";

import { memoryKeptSessionStore, type KeptSessionStore } from "../player/kept-sessions.js";
import {
  compilePlayerProject,
  createPlayerRuntimeSession,
  playerRuntimeForeground,
  submitPlayerRuntimeComposer,
  type PlayerRuntimeControlResult,
  type PlayerRuntimeSession,
  type PlayerRuntimeSessionOptions,
} from "../player/runtime-adapter.js";
import type { ScriptStorageProvider } from "../player/script-storage.js";
import {
  readPlayerTransferFile,
  sessionTransferFile,
  type SessionTransfer,
} from "../player/session-transfer.js";
import type {
  InstructionPlan,
  RuntimeScriptStorageEntrySnapshot,
  SerializableRuntimeValue,
} from "../src/index.js";
import { FakeMediaRepository } from "./helpers/fake-media-repository.js";
import { loadPlayerModule } from "./helpers/player-modules.js";

interface SessionExport {
  readonly transfer: SessionTransfer;
  readonly missing: number;
}
interface SessionImportReview {
  readonly currentValues: number;
}
interface TransferHost {
  readonly session: Readonly<Ref<PlayerRuntimeSession | null>>;
  readonly activation: Readonly<Ref<"start" | "continue" | null>>;
  readonly sessionExportUnavailable: Readonly<Ref<string | null>>;
  readonly notices: Readonly<Ref<readonly { readonly key: string; readonly message: string }[]>>;
  exportSession(): Promise<SessionExport>;
  reviewSessionImport(transfer: SessionTransfer): Promise<SessionImportReview>;
  importSession(review: SessionImportReview): Promise<void>;
  resolveAsset(path: string): string | null;
  readonly images: {
    store(
      file: File,
      filters: { types: readonly string[] | null; mime: readonly string[] | null },
    ): Promise<{ readonly reference: string } | { readonly message: string }>;
  };
  readonly imageCapture: {
    choose(reference: string): boolean;
    use(session: PlayerRuntimeSession): PlayerRuntimeControlResult | null;
  };
  loadScriptStorage(): Promise<void>;
  scriptStorageOptions(): PlayerRuntimeSessionOptions;
  prepareScript(
    plan: InstructionPlan,
    create: (options: PlayerRuntimeSessionOptions) => PlayerRuntimeSession,
  ): Promise<void>;
  activate(): Promise<void>;
  update(session: PlayerRuntimeSession): void;
}
let usePlayerSession: (options: {
  scriptStorage: ScriptStorageProvider;
  capturedMedia: { repository: FakeMediaRepository };
  keptSessions: KeptSessionStore;
  decodeImage: (data: Blob) => Promise<{ width: number; height: number }>;
}) => TransferHost;

// Load the real Vue composable through the existing build tool: its browser-source imports use Vite resolution.
before(async () => {
  const module: Record<string, unknown> = await loadPlayerModule(
    "player/vue/src/usePlayerSession.ts",
  );
  assert.equal(typeof module.usePlayerSession, "function");
  // EVIDENCE: validation: Vite loaded the real source module and the export is callable; this is its tested host API.
  usePlayerSession = module.usePlayerSession as typeof usePlayerSession;
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

const SCOPE = "development-package:saved-photo";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

/** One browser: its saved values of the script, its stored photos, and its kept sessions. */
function browser() {
  const entries = new Map<string, SerializableRuntimeValue>();
  const provider: ScriptStorageProvider = {
    scope: SCOPE,
    load: async (): Promise<readonly RuntimeScriptStorageEntrySnapshot[]> =>
      [...entries].map(([key, value]) => ({ key, value })),
    write: async (key, value) =>
      void (value === null ? entries.delete(key) : entries.set(key, value)),
    replace: async (next) => {
      entries.clear();
      for (const { key, value } of next) entries.set(key, value);
    },
    clear: async () => entries.clear(),
  };
  return {
    entries,
    provider,
    repository: new FakeMediaRepository(),
    kept: memoryKeptSessionStore(),
  };
}

/** A page of the Player in `at`, showing the script of `plan`; a reload is a new page of the same browser. */
async function page(context: TestContext, at: ReturnType<typeof browser>, plan: InstructionPlan) {
  const scope = effectScope();
  const host = scope.run(() =>
    usePlayerSession({
      scriptStorage: at.provider,
      capturedMedia: { repository: at.repository },
      keptSessions: at.kept,
      decodeImage: async () => ({ width: 2, height: 2 }),
    }),
  );
  assert.ok(host);
  context.after(() => scope.stop());
  await host.loadScriptStorage();
  await host.prepareScript(plan, (options) =>
    createPlayerRuntimeSession(plan, { ...options, ...host.scriptStorageOptions() }),
  );
  return host;
}

async function until(condition: () => boolean | Promise<boolean>, message: string) {
  const deadline = Date.now() + 2_000;
  while (!(await condition())) {
    assert.ok(Date.now() < deadline, message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Chooses an image file and answers the image request with it, as "Use image" does. */
async function answerImage(host: TransferHost, name: string): Promise<string> {
  const stored = await host.images.store(new File([PNG], name), { types: null, mime: null });
  assert.ok("reference" in stored, name);
  assert.equal(host.imageCapture.choose(stored.reference), true);
  const result = host.imageCapture.use(host.session.value!);
  assert.equal(result?.outcome.kind, "completed");
  host.update(result!.session);
  return stored.reference;
}

const said = (session: PlayerRuntimeSession | null) =>
  session?.transcriptEntries.map((entry) => entry.text) ?? [];

const SAVED_PHOTO = compilePlayerProject(
  'let picture: string = askImage(hint: "Add an image to save")\nsave picture as "photo"\nsay "Saved.", instant\nlet unsaved: string = askImage(hint: "Add an image that stays unsaved")\nshowImage unsaved\nlet done = askText(hint: "Anything else?")\nsay "Thanks, ${done}.", instant\nexit',
).plan!;

test("a session exported in one browser continues in another after the import, as Continue does after a reload", async (context) => {
  stubBrowser(context);
  const first = browser();
  const exporting = await page(context, first, SAVED_PHOTO);
  assert.equal(
    exporting.sessionExportUnavailable.value,
    "Available while a session runs or waits for Continue.",
  );
  await exporting.activate();
  const saved = await answerImage(exporting, "saved.png");
  await until(
    () => playerRuntimeForeground(exporting.session.value!)?.kind === "ask-image",
    "the save was not serviced",
  );
  const unsaved = await answerImage(exporting, "unsaved.png");
  assert.equal(playerRuntimeForeground(exporting.session.value!)?.kind, "ask-text");
  assert.equal(exporting.sessionExportUnavailable.value, null);
  const { transfer, missing } = await exporting.exportSession();
  assert.equal(missing, 0);
  assert.deepEqual(transfer.entries, [{ key: "photo", value: saved }]);
  assert.deepEqual(
    new Set(transfer.media.map((medium) => medium.reference)),
    new Set([saved, unsaved]),
  );
  const file = new Uint8Array(await (await sessionTransferFile(transfer, true)).arrayBuffer());

  // Another browser, which plays a session of its own until the import ends it.
  const second = browser();
  const importing = await page(context, second, SAVED_PHOTO);
  await importing.activate();
  const read = await readPlayerTransferFile(file);
  assert.equal(read.kind, "session");
  if (read.kind !== "session") return;
  const review = await importing.reviewSessionImport(read.session);
  assert.equal(review.currentValues, 0);
  assert.equal(playerRuntimeForeground(importing.session.value!)?.kind, "ask-image");
  await importing.importSession(review);
  assert.equal(importing.session.value, null);
  assert.equal(importing.activation.value, "continue");
  assert.deepEqual([...second.entries], [["photo", saved]]);
  assert.deepEqual(await second.repository.listReferences(SCOPE), [saved]);
  // The photo only the session uses is kept with it, as a kept session's.
  assert.deepEqual(await second.kept.media.listReferences(SCOPE), [unsaved]);
  // The same session is the same media again, but another photo under one of its references is refused.
  await importing.reviewSessionImport(read.session);
  const altered: SessionTransfer = {
    ...read.session,
    media: read.session.media.map((medium) =>
      medium.reference === unsaved ? { ...medium, bytes: medium.bytes.slice().reverse() } : medium,
    ),
  };
  await assert.rejects(
    importing.reviewSessionImport(altered),
    (error: unknown) =>
      error instanceof Error &&
      /keeps another photo or file under the reference/.test(error.message),
  );

  // A reload of the importing browser finds the session too; Continue goes on at the question.
  const reloaded = await page(context, second, SAVED_PHOTO);
  assert.equal(reloaded.activation.value, "continue");
  assert.equal(reloaded.sessionExportUnavailable.value, null);
  await reloaded.activate();
  assert.equal(playerRuntimeForeground(reloaded.session.value!)?.kind, "ask-text");
  assert.notEqual(reloaded.resolveAsset(unsaved), null, "the unsaved photo is session media");
  const answered = submitPlayerRuntimeComposer(reloaded.session.value!, "nothing");
  reloaded.update(answered!.session);
  assert.equal(reloaded.session.value?.state.status, "halted");
  assert.ok(
    said(reloaded.session.value).includes("Saved."),
    "the transcript before the export stays",
  );
  assert.equal(said(reloaded.session.value).at(-1), "Thanks, nothing.");
});
