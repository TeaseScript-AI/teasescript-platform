import assert from "node:assert/strict";
import test from "node:test";

import { CapturedMediaNotStoredError, CapturedMediaStore } from "../player/captured-media.js";
import {
  capturedMediaReferences,
  openCapturedMediaScope,
  sweepCapturedMedia,
  withCapturedMedia,
  type CapturedMediaLocks,
  type ScriptStorageProvider,
} from "../player/captured-media-persistence.js";
import {
  compileSource,
  completeAction,
  createFreshRuntimeSnapshot,
  run,
  type RuntimeScriptStorageEntrySnapshot,
  type RuntimeSnapshot,
  type SerializableRuntimeValue,
} from "../src/index.js";
import { FakeMediaRepository } from "./helpers/fake-media-repository.js";

const urls = { create: (data: Blob) => `blob:${data.size}`, revoke: () => {} };
const png = (text: string) => new Blob([text], { type: "image/png" });

// The storage track's provider stand-in: an in-memory durable view with an operation log.
class FakeProvider implements ScriptStorageProvider {
  readonly scope = "package";
  readonly entries = new Map<string, SerializableRuntimeValue>();
  readonly log: string[] = [];
  failLoad = false;
  async load(): Promise<readonly RuntimeScriptStorageEntrySnapshot[]> {
    this.log.push("load");
    if (this.failLoad) throw new Error("unreadable");
    return [...this.entries].map(([key, value]) => ({ key, value }));
  }
  async write(key: string, value: SerializableRuntimeValue) {
    this.log.push(`write ${key}`);
    if (value === null) this.entries.delete(key);
    else this.entries.set(key, value);
  }
  async clear() {
    this.log.push("clear");
    this.entries.clear();
  }
}

const lease = { granted: Promise.resolve("held" as const), release: () => {} };
const idle: CapturedMediaLocks = {
  holdLive: () => lease,
  whenIdle: async (_scope, work) => (await work(), true),
};
const busy: CapturedMediaLocks = { holdLive: () => lease, whenIdle: async () => false };

test("references are found in every stored value shape, and nothing else counts", () => {
  const value: SerializableRuntimeValue = {
    kind: "object",
    properties: [
      { name: "captured-media:k:1", value: 1 },
      { name: "shot", value: "captured-media:v:1" },
      {
        name: "nested",
        value: {
          kind: "list",
          items: ["captured-media:l:1", { kind: "set", items: ["captured-media:s:1", "plain"] }],
        },
      },
      { name: "range", value: { kind: "range", start: 1, end: 2, inclusive: true } },
    ],
  };
  assert.deepEqual([...capturedMediaReferences(value)].sort(), [
    "captured-media:k:1",
    "captured-media:l:1",
    "captured-media:s:1",
    "captured-media:v:1",
  ]);
  assert.equal(capturedMediaReferences("images/coast.svg").size, 0);
  assert.equal(capturedMediaReferences(null).size, 0);
});

test("a save stores its photo durably before the value is persisted", async () => {
  const repository = new FakeMediaRepository();
  const media = new CapturedMediaStore(repository, urls, "package");
  const provider = new FakeProvider();
  const photo = media.add("image", png("photo")).reference;
  const storage = withCapturedMedia(provider, media);
  const persistedBefore: number[] = [];
  const write = provider.write.bind(provider);
  provider.write = async (key, value) => {
    persistedBefore.push(repository.size);
    await write(key, value);
  };
  await storage.write("album", { kind: "list", items: [photo] });
  assert.deepEqual(persistedBefore, [1]);
  assert.deepEqual(provider.entries.get("album"), { kind: "list", items: [photo] });
});

test("a save whose photo cannot be stored is not persisted and keeps the previous value", async () => {
  const repository = new FakeMediaRepository();
  const media = new CapturedMediaStore(repository, urls, "package");
  const provider = new FakeProvider();
  provider.entries.set("photo", "previous");
  const storage = withCapturedMedia(provider, media);
  const photo = media.add("image", png("photo")).reference;
  repository.failWrites = true;
  await assert.rejects(storage.write("photo", photo), CapturedMediaNotStoredError);
  assert.equal(provider.entries.get("photo"), "previous");
  // The photo stays usable this session, and a later save can try again.
  assert.equal(media.resolve(photo).state, "ready");
  repository.failWrites = false;
  await storage.write("photo", photo);
  assert.equal(provider.entries.get("photo"), photo);
  // Values without captured media never need durable media storage.
  const unstored = withCapturedMedia(provider, new CapturedMediaStore(null, urls, "package"));
  await unstored.write("score", 3);
  assert.equal(provider.entries.get("score"), 3);
});

test("storage operations run in issue order, so a clear is never refilled by an earlier save", async () => {
  const repository = new FakeMediaRepository();
  const media = new CapturedMediaStore(repository, urls, "package");
  const provider = new FakeProvider();
  const storage = withCapturedMedia(provider, media);
  const photo = media.add("image", png("photo")).reference;
  const saving = storage.write("photo", photo);
  const clearing = storage.clear();
  await Promise.all([saving, clearing]);
  assert.deepEqual(provider.log, ["write photo", "clear"]);
  assert.equal(provider.entries.size, 0);
});

test("a sweep runs only when no Player is live, against a fresh read of the saved values", async () => {
  const repository = new FakeMediaRepository();
  const earlier = new CapturedMediaStore(repository, urls, "package");
  const provider = new FakeProvider();
  const storage = withCapturedMedia(provider, earlier);
  const kept = earlier.add("image", png("kept")).reference;
  const dropped = earlier.add("image", png("dropped")).reference;
  await storage.write("a", kept);
  await storage.write("b", { kind: "object", properties: [{ name: "shot", value: dropped }] });
  // Overwriting one of two references keeps the photo; removing the last one makes it unreachable.
  await storage.write("c", kept);
  await storage.write("a", null);
  await storage.write("b", null);
  earlier.close();
  const later = new CapturedMediaStore(repository, urls, "package");
  assert.equal(await sweepCapturedMedia(provider, later, busy), false);
  assert.equal(repository.size, 2);
  provider.failLoad = true;
  await assert.rejects(sweepCapturedMedia(provider, later, idle));
  assert.equal(repository.size, 2);
  provider.failLoad = false;
  assert.equal(await sweepCapturedMedia(provider, later, idle), true);
  assert.deepEqual(await repository.listReferences("package"), [kept]);
  // Clearing saved data releases the rest at the next sweep.
  await withCapturedMedia(provider, later).clear();
  await sweepCapturedMedia(provider, later, idle);
  assert.equal(repository.size, 0);
});

/** Runs a script, answering each `takePhoto()` from `media`, and persists its saves through `storage`. */
async function runWithCamera(
  source: string,
  media: CapturedMediaStore,
  storage: ScriptStorageProvider,
): Promise<RuntimeSnapshot> {
  const compiled = compileSource(source);
  assert.deepEqual(compiled.diagnostics, []);
  const plan = compiled.plan!;
  let snapshot = createFreshRuntimeSnapshot(plan, { scriptStorage: await storage.load() });
  for (;;) {
    const operation = run(plan, snapshot);
    for (const event of operation.events)
      if (event.kind === "scriptStorageChanged") await storage.write(event.key, event.value);
    const action = operation.snapshot.foregroundAction;
    if (action?.kind !== "capture") return operation.snapshot;
    const reference = media.add("image", png("the photo")).reference;
    snapshot = completeAction(
      plan,
      operation.snapshot,
      {
        actionId: action.actionId,
        actionKind: "capture",
        payload: { kind: "captured", media: { kind: "image", reference } },
      },
      { capturedMedia: media },
    ).snapshot;
  }
}

test("a photo saved in one run is loaded and shown in a later run; a forged reference is not", async () => {
  const repository = new FakeMediaRepository();
  const provider = new FakeProvider();
  const firstRun = new CapturedMediaStore(repository, urls, "package");
  const first = await runWithCamera(
    'let photo: string? = takePhoto()\nif photo != null {\n  save { label: "first", shot: photo } as "album"\n}',
    firstRun,
    withCapturedMedia(provider, firstRun),
  );
  assert.equal(first.status, "halted");
  firstRun.close();

  const secondRun = new CapturedMediaStore(repository, urls, "package");
  const second = await runWithCamera(
    'let album = load "album"\nshowImage album.shot',
    secondRun,
    withCapturedMedia(provider, secondRun),
  );
  const shown = second.stageImage;
  assert.ok(shown !== null);
  assert.equal(secondRun.resolve(shown).state, "loading");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondRun.resolve(shown).state, "ready");
  assert.equal(await (await secondRun.read(shown))?.data.text(), "the photo");

  // A string of the right shape that the store never created grants nothing, also after `save` and `load`.
  const forged = shown.replace(/:\d+$/u, ":99");
  const third = await runWithCamera(
    `save "${forged}" as "fake"\nshowImage load "fake"`,
    secondRun,
    withCapturedMedia(provider, secondRun),
  );
  assert.equal(third.stageImage, forged);
  secondRun.resolve(forged);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(secondRun.resolve(forged), { state: "missing" });
  assert.equal(repository.size, 1);
});

test("a Player opens persistence by sweeping, then holding the live lock, then reading its saved values", async () => {
  const repository = new FakeMediaRepository();
  const provider = new FakeProvider();
  const order: string[] = [];
  let releaseWrite = () => {};
  const write = provider.write.bind(provider);
  provider.write = async (key, value) => {
    await new Promise<void>((resolve) => (releaseWrite = resolve));
    order.push("persisted");
    await write(key, value);
  };
  const locks: CapturedMediaLocks = {
    holdLive: () => {
      order.push("live lock");
      return { granted: Promise.resolve("held"), release: () => order.push("released") };
    },
    whenIdle: async (_scope, work) => {
      order.push("sweep");
      await work();
      return true;
    },
  };
  const media = new CapturedMediaStore(repository, urls, "package");
  const scope = await openCapturedMediaScope(provider, media, locks);
  assert.deepEqual(order, ["sweep", "live lock"]);
  assert.deepEqual(provider.log, ["load", "load"]);
  // Unmounting finishes an issued save before the live lock is released.
  const saving = scope.storage.write("photo", media.add("image", png("photo")).reference);
  const closing = scope.close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["sweep", "live lock"]);
  releaseWrite();
  await Promise.all([saving, closing]);
  assert.deepEqual(order, ["sweep", "live lock", "persisted", "released"]);
  await assert.rejects(scope.storage.write("late", 1));
});

test("without the live lock where locks exist, saved photos are not made durable", async () => {
  const repository = new FakeMediaRepository();
  const provider = new FakeProvider();
  const media = new CapturedMediaStore(repository, urls, "package");
  const failing: CapturedMediaLocks = {
    holdLive: () => ({ granted: Promise.resolve("failed"), release: () => {} }),
    whenIdle: async () => false,
  };
  const scope = await openCapturedMediaScope(provider, media, failing);
  const photo = media.add("image", png("photo")).reference;
  await assert.rejects(scope.storage.write("photo", photo), CapturedMediaNotStoredError);
  assert.equal(repository.size, 0);
  assert.equal(provider.entries.size, 0);
});
