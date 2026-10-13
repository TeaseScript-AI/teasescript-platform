import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { before, type TestContext } from "node:test";
import { effectScope, type Ref } from "vue";

import { CapturedMediaStore } from "../player/captured-media.js";
import {
  createPlayerRuntimeSession,
  playerRuntimeSnapshot,
  type PlayerRuntimeSession,
  type PlayerRuntimeSessionOptions,
} from "../player/runtime-adapter.js";
import type { ScriptStorageProvider } from "../player/script-storage.js";
import { answerFileStore } from "../player/stored-files.js";
import type {
  RuntimeFileStoreActionSnapshot,
  RuntimeFileToStore,
  SerializableRuntimeValue,
} from "../src/index.js";
import { FakeMediaRepository } from "./helpers/fake-media-repository.js";
import { loadPlayerModule } from "./helpers/player-modules.js";

/*
 * The Player's file store for fileFromBase64, fileToBase64, hashFile, and toJson and fromJson with files (V30 §13 and
 * §33): files are session media of the kind of their type, durable only while a saved value references them, and only
 * an image is ever shown.
 */

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).toString(
  "base64",
);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString("base64");
const OGG = Buffer.from("OggS\0\x02\0\0", "latin1").toString("base64");
const urls = { create: (data: Blob) => `blob:${data.type}`, revoke: () => {} };

function request(
  operation: "store" | "read" | "hash",
  files: readonly RuntimeFileToStore[],
  references: readonly string[] = [],
): RuntimeFileStoreActionSnapshot {
  return {
    kind: "fileStore",
    actionId: 1,
    owningInstruction: 0,
    continuationInstruction: 0,
    ownerCallFrameId: null,
    scopeDepth: 1,
    loopDepth: 0,
    destinationTemporary: 1,
    createdAtMs: 0,
    requestEventSequence: 1,
    operation,
    files,
    references,
  };
}

test("the Player keeps files as session media of the kind of their type, and reads their bytes back", async () => {
  const media = new CapturedMediaStore(null, urls, "files");
  const stored = await answerFileStore(
    request("store", [
      { type: "image/png", base64: PNG },
      { type: "application/octet-stream", base64: SVG },
      { type: "audio/ogg", base64: OGG },
    ]),
    media,
  );
  assert.equal(stored.kind, "stored");
  const [image, page, sound] = stored.kind === "stored" ? stored.references : [];
  assert.deepEqual(
    [media.holds(image!, "image"), media.holds(page!, "file"), media.holds(sound!, "audio")],
    [true, true, true],
  );
  // Only an image is shown: never a file of no recognized type, such as SVG, nor audio.
  assert.deepEqual(media.resolve(image!, "image"), { state: "ready", url: "blob:image/png" });
  assert.deepEqual(media.resolve(page!, "image"), { state: "missing" });
  assert.deepEqual(media.resolve(sound!, "image"), { state: "missing" });
  assert.deepEqual(await answerFileStore(request("read", [], [page!, image!]), media), {
    kind: "read",
    files: [SVG, PNG],
  });
  // A file the store does not have cannot be read.
  assert.deepEqual(
    await answerFileStore(
      request("read", [], ["captured-media:00000000-0000-4000-8000-000000000000:9"]),
      media,
    ),
    { kind: "failed" },
  );
});

test("the Player hashes a stored file with the browser's digest, and fails without one outside a secure context", async (context) => {
  const media = new CapturedMediaStore(null, urls, "files");
  const stored = await answerFileStore(
    request("store", [
      { type: "image/png", base64: PNG },
      { type: "application/octet-stream", base64: SVG },
    ]),
    media,
  );
  const references = stored.kind === "stored" ? stored.references : [];
  // As sha256sum gives them for the bytes.
  const hashed = {
    kind: "hashed",
    hashes: [
      createHash("sha256").update(Buffer.from(PNG, "base64")).digest("hex"),
      "900fbe934249ad120004bd24adf66aad8817d89586273c0cc50e187bddebb601",
    ],
  };
  assert.deepEqual(await answerFileStore(request("hash", [], references), media), hashed);
  assert.deepEqual(
    await answerFileStore(
      request("hash", [], ["captured-media:00000000-0000-4000-8000-000000000000:9"]),
      media,
    ),
    { kind: "failed" },
  );
  // Browsers offer crypto.subtle only in secure contexts; a Player over plain HTTP on a local network has none, and
  // answers that it failed rather than leaving the script waiting.
  const subtle = Object.getOwnPropertyDescriptor(crypto, "subtle");
  Object.defineProperty(crypto, "subtle", { configurable: true, value: undefined });
  context.after(() => {
    if (subtle) Object.defineProperty(crypto, "subtle", subtle);
    else Reflect.deleteProperty(crypto, "subtle");
  });
  assert.deepEqual(await answerFileStore(request("hash", [], references), media), {
    kind: "failed",
  });
});

test("a stored file of no recognized type is kept and read back from durable storage only with its type", async () => {
  const repository = new FakeMediaRepository();
  const media = new CapturedMediaStore(repository, urls, "files");
  const stored = await answerFileStore(
    request("store", [{ type: "application/octet-stream", base64: SVG }]),
    media,
  );
  const reference = stored.kind === "stored" ? stored.references[0]! : "";
  await media.promote([reference]);
  const later = new CapturedMediaStore(repository, urls, "files");
  assert.deepEqual(await answerFileStore(request("read", [], [reference]), later), {
    kind: "read",
    files: [SVG],
  });
  // A record that claims to be a file of another type is not one.
  const record = repository.records.get(`files ${reference}`);
  assert.ok(record !== undefined);
  repository.records.set(`files ${reference}`, { ...record, mimeType: "image/svg+xml" });
  const forged = new CapturedMediaStore(repository, urls, "files");
  assert.equal(await forged.read(reference), null);
});

interface FileHost {
  readonly session: Readonly<Ref<PlayerRuntimeSession | null>>;
  resolveAsset(path: string): string | null;
  loadScriptStorage(): Promise<void>;
  scriptStorageOptions(): PlayerRuntimeSessionOptions;
  prepare(create: (options: PlayerRuntimeSessionOptions) => PlayerRuntimeSession): void;
  activate(): Promise<void>;
}
let usePlayerSession: (options: {
  scriptStorage?: ScriptStorageProvider;
  capturedMedia?: { repository: FakeMediaRepository };
}) => FileHost;

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

function memoryStorage(scope: string) {
  const entries = new Map<string, SerializableRuntimeValue>();
  const provider: ScriptStorageProvider = {
    scope,
    load: async () => [...entries].map(([key, value]) => ({ key, value })),
    write: async (key, value) =>
      void (value === null ? entries.delete(key) : entries.set(key, value)),
    replace: async (next) => {
      entries.clear();
      for (const { key, value } of next) entries.set(key, value);
    },
    clear: async () => entries.clear(),
  };
  return { entries, provider };
}

/** Plays `source` in a mounted Player with `storage` and `repository` until it ends, and gives its variables. */
async function playInPlayer(
  context: TestContext,
  source: string,
  storage: ScriptStorageProvider,
  repository: FakeMediaRepository,
) {
  const scope = effectScope();
  const host = scope.run(() =>
    usePlayerSession({ scriptStorage: storage, capturedMedia: { repository } }),
  );
  assert.ok(host);
  context.after(() => scope.stop());
  await host.loadScriptStorage();
  host.prepare(() => createPlayerRuntimeSession(source, host.scriptStorageOptions()));
  await host.activate();
  const deadline = Date.now() + 2_000;
  while (host.session.value?.state.status !== "halted") {
    assert.ok(
      Date.now() < deadline,
      `the session did not end: ${host.session.value?.state.status}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const snapshot = playerRuntimeSnapshot(host.session.value);
  return {
    host,
    scope,
    events: host.session.value.events,
    variables: Object.fromEntries(
      snapshot.frames[0]!.bindings.map((binding) => [binding.name, binding.value]),
    ),
  };
}

test("a Player stores and reads files, shows only images, and knows saved files in its next session", async (context) => {
  stubBrowser(context);
  const repository = new FakeMediaRepository();
  const { entries, provider } = memoryStorage("files");
  const first = await playInPlayer(
    context,
    [
      `let picture = fileFromBase64("${PNG}", default: "")`,
      `let page = fileFromBase64("data:image/svg+xml;base64,${SVG}", default: "")`,
      'save picture as "picture"',
      'save page as "page"',
      "let json = toJson([picture, page])",
      "let read = fromJson(json, default: null)",
      "exit",
    ].join("\n"),
    provider,
    repository,
  );
  const { picture, page, json, read } = first.variables;
  assert.ok(typeof picture === "string" && typeof page === "string");
  assert.equal(
    json,
    JSON.stringify([`data:image/png;base64,${PNG}`, `data:application/octet-stream;base64,${SVG}`]),
  );
  // The image becomes a new stored file; the SVG, of no recognized type, stays its data URL.
  assert.ok(read !== null && typeof read === "object" && read.kind === "list");
  assert.equal(read.items[1], `data:application/octet-stream;base64,${SVG}`);
  assert.notEqual(first.host.resolveAsset(picture), null);
  const restored = read.items[0];
  assert.ok(typeof restored === "string");
  assert.notEqual(first.host.resolveAsset(restored), null);
  assert.equal(first.host.resolveAsset(page), null);
  // Saved files became durable under the script's scope, the SVG as a file.
  assert.deepEqual(
    [...entries],
    [
      ["picture", picture],
      ["page", page],
    ],
  );
  assert.deepEqual(
    [...repository.records.values()].map((record) => [
      record.reference,
      record.kind,
      record.mimeType,
    ]),
    [
      [picture, "image", "image/png"],
      [page, "file", "application/octet-stream"],
    ],
  );
  first.scope.stop();

  const second = await playInPlayer(
    context,
    [
      'let picture: string = load("picture", default: "")',
      'let page: string = load("page", default: "")',
      "let data = fileToBase64(page)",
      "let hash = hashFile(page)",
      "let json = toJson({ picture: picture })",
      "exit",
    ].join("\n"),
    provider,
    repository,
  );
  assert.deepEqual(second.variables, {
    picture,
    page,
    data: SVG,
    hash: "900fbe934249ad120004bd24adf66aad8817d89586273c0cc50e187bddebb601",
    json: JSON.stringify({ picture: `data:image/png;base64,${PNG}` }),
  });
});

test("when the browser's storage is full a save of a file keeps the previous value, and the file stays usable", async (context) => {
  stubBrowser(context);
  class FullRepository extends FakeMediaRepository {
    override async add(): Promise<void> {
      throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    }
  }
  const repository = new FullRepository();
  const { entries, provider } = memoryStorage("full");
  entries.set("picture", "previous");
  const played = await playInPlayer(
    context,
    [
      `let picture = fileFromBase64("${PNG}", default: "")`,
      'save picture as "picture"',
      "let data = fileToBase64(picture)",
      'let kept: string = load("picture", default: "")',
      "exit",
    ].join("\n"),
    provider,
    repository,
  );
  const { picture, data, kept } = played.variables;
  assert.deepEqual([data, kept], [PNG, "previous"]);
  assert.deepEqual([...entries], [["picture", "previous"]]);
  assert.deepEqual(
    played.events.flatMap((event) => (event.kind === "developerWarning" ? [event.code] : [])),
    ["TSW014"],
  );
  assert.ok(typeof picture === "string");
  assert.notEqual(played.host.resolveAsset(picture), null);
  assert.equal(repository.size, 0);
});

test("saved text that only has the shape of a reference stays text in a later session", async (context) => {
  stubBrowser(context);
  const repository = new FakeMediaRepository();
  const { provider } = memoryStorage("shapes");
  const shaped = "captured-media:00000000-0000-4000-8000-000000000000:1";
  const first = await playInPlayer(
    context,
    [
      `let shaped = "${shaped}"`,
      'save shaped as "text"',
      'save [shaped] as "list"',
      'save { file: shaped } as "object"',
      'save dict { "${shaped}": 1 } as "keyed"',
      `let picture = fileFromBase64("${PNG}", default: "")`,
      'save picture as "picture"',
      "exit",
    ].join("\n"),
    provider,
    repository,
  );
  const { picture } = first.variables;
  first.scope.stop();
  const later = await playInPlayer(
    context,
    [
      'let text: string = load("text", default: "")',
      'let items: string[] = load("list", default: [])',
      'let keyed = load("keyed", default: dict { "": 0 })',
      'let picture: string = load("picture", default: "")',
      "let json = toJson({ text: text, list: items, keys: keyed.keys, picture: picture })",
      "exit",
    ].join("\n"),
    provider,
    repository,
  );
  assert.equal(
    later.variables.json,
    JSON.stringify({
      text: shaped,
      list: [shaped],
      keys: [shaped],
      picture: `data:image/png;base64,${PNG}`,
    }),
  );
  assert.deepEqual(playerRuntimeSnapshot(later.host.session.value!).storedFiles, [picture]);
});
