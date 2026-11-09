import assert from "node:assert/strict";
import test, { before, type TestContext } from "node:test";
import { effectScope, type Ref } from "vue";

import {
  memoryKeptRoomStore,
  memoryKeptSessionStore,
  type KeptRoomStore,
  type KeptSessionStore,
} from "../../player/persistence/kept-sessions.js";
import {
  activatePlayerRuntimeButton as rawActivatePlayerRuntimeButton,
  submitPlayerRuntimeComposer as rawSubmitPlayerRuntimeComposer,
  type PlayerRuntimeSession,
  type PlayerRuntimeSessionOptions,
} from "../../player/runtime/runtime-adapter.js";
import {
  compilePlayerProject,
  createPlayerRuntimeSession,
} from "../../player/runtime/compile-project.js";
import { preparedPlan } from "../helpers/prepared-plan.js";
import type { PlayerBridge } from "../../player/runtime/player-bridge.js";
import {
  createLocalScriptStorage,
  type ScriptStorageProvider,
} from "../../player/persistence/script-storage.js";
import type { InstructionPlan } from "../../src/index.js";
import { FakeMediaRepository } from "../helpers/player/fake-media-repository.js";
import { loadPlayerModule } from "../helpers/player-modules.js";
import { answerWith, type Intent } from "../helpers/player/player-input.js";
import { loadHostFacade, onHost } from "../helpers/player/host-sessions.js";

// A kept session or saved value names captured media only once its bytes are in the current destination (#1861): a
// photo its store refused keeps the session kept before, a valid duplicate counts as stored, and a read that settles
// after the destination changed, or a debug room that could not be created as a copy, certifies nothing there. Fresh
// pages of the same browser show what a reload continues; the destination's bytes are asserted directly.

const activatePlayerRuntimeButton = onHost(rawActivatePlayerRuntimeButton);
const submitPlayerRuntimeComposer = onHost(rawSubmitPlayerRuntimeComposer);

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
  activate(): Promise<void>;
  update(session: PlayerRuntimeSession): void;
  readonly inputSection: unknown;
  setDebugMode(enabled: boolean): void;
  resolveAsset(path: string): string | null;
  savedPhoto(reference: string): { readonly state: string };
}
let usePlayerSession: (options: {
  scriptStorage: ScriptStorageProvider;
  capturedMedia: { repository: FakeMediaRepository };
  keptSessions: KeptSessionStore;
  debugRooms: KeptRoomStore;
  room?: "debug";
  decodeImage: (data: Blob) => Promise<{ width: number; height: number }>;
}) => Host;

before(async () => {
  await loadHostFacade();
  const module: Record<string, unknown> = await loadPlayerModule(
    "player/vue/src/session/usePlayerSession.ts",
  );
  assert.equal(typeof module.usePlayerSession, "function");
  // EVIDENCE: validation: Vite loaded the real source module and the export is callable; this is its tested host API.
  usePlayerSession = module.usePlayerSession as typeof usePlayerSession;
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

const SCOPE = "development-package:media";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const KEEP = compilePlayerProject(
  'let picture: string = askImage(hint: "Add an image")\nlet w = askText("Kept")\nlet l = askText("Later")\nexit',
).plan!;
const SAVE = compilePlayerProject(
  'let picture: string = askImage(hint: "Add an image")\nsave picture as "photo"\nlet w = askText("Saved")\nexit',
).plan!;
const LOADED = compilePlayerProject(
  'let picture: string = load("photo", default: "")\nlet w = askText("Loaded")\nexit',
).plan!;

/** How a store answers a photo write: it stores it, refuses it, or stores it and then reports a failure. */
type PhotoWrites = "store" | "refuse" | "commitThenFail";

/**
 * One browser: the script's saved values, its stored photos, kept sessions and debug rooms. A photo write of the kept
 * store or the rooms can be refused, or committed and then reported as failed; a room photo read can be held; and the
 * next room discard can be refused.
 */
function browser() {
  const storage = new MemoryStorage();
  const repository = new FakeMediaRepository();
  const innerKept = memoryKeptSessionStore();
  const innerRooms = memoryKeptRoomStore();
  const writes: { kept: PhotoWrites; rooms: PhotoWrites } = { kept: "store", rooms: "store" };
  const refuseDiscard = { rooms: false };
  const roomRead = new Hold();
  const full = () => new DOMException("The storage is full.", "QuotaExceededError");
  const add = async (
    mode: PhotoWrites,
    store: (record: Parameters<KeptSessionStore["media"]["add"]>[0]) => Promise<void>,
    record: Parameters<KeptSessionStore["media"]["add"]>[0],
  ) => {
    if (mode === "refuse") throw full();
    await store(record);
    if (mode === "commitThenFail") throw full();
  };
  const kept: KeptSessionStore = {
    ...innerKept,
    media: { ...innerKept.media, add: (record) => add(writes.kept, innerKept.media.add, record) },
  };
  const rooms: KeptRoomStore = {
    ...innerRooms,
    media: {
      ...innerRooms.media,
      get: async (scope, reference) => roomRead.pass(await innerRooms.media.get(scope, reference)),
      add: (record) => add(writes.rooms, innerRooms.media.add, record),
    },
    async discard(scope) {
      if (refuseDiscard.rooms) {
        refuseDiscard.rooms = false;
        throw full();
      }
      return innerRooms.discard(scope);
    },
  };
  return {
    storage,
    repository,
    innerKept,
    innerRooms,
    kept,
    rooms,
    writes,
    refuseDiscard,
    roomRead,
  };
}
type Browser = ReturnType<typeof browser>;

function page(context: TestContext, at: Browser, room?: "debug") {
  const scope = effectScope();
  const host = scope.run(() =>
    usePlayerSession({
      scriptStorage: createLocalScriptStorage(at.storage, SCOPE),
      capturedMedia: { repository: at.repository },
      keptSessions: at.kept,
      debugRooms: at.rooms,
      ...(room === undefined ? {} : { room }),
      decodeImage: async () => ({ width: 2, height: 2 }),
    }),
  );
  assert.ok(host);
  context.after(() => scope.stop());
  return { host, close: () => scope.stop() };
}

async function opened(context: TestContext, at: Browser, plan: InstructionPlan, room?: "debug") {
  const made = page(context, at, room);
  await made.host.loadScriptStorage();
  await made.host.prepareScript(await preparedPlan(made.host.bridge, plan), (options) =>
    createPlayerRuntimeSession(plan, { ...options, ...made.host.scriptStorageOptions() }),
  );
  return made;
}

async function until(condition: () => boolean | Promise<boolean>, message: string) {
  const deadline = Date.now() + 2_000;
  while (!(await condition())) {
    assert.ok(Date.now() < deadline, message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
/** Lets keeps and saves the host issued in later tasks finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
const said = (host: Host) =>
  host.session.value?.transcriptEntries.map((entry) => entry.text).join(" | ") ?? "";

/** Answers the image question with a new photo; resolves to its reference. */
async function answerImage(host: Host): Promise<string> {
  await until(() => host.session.value?.state.status === "waiting", "no question");
  const stored = await host.images.store(new File([PNG], "photo.png"), { types: null, mime: null });
  assert.ok("reference" in stored);
  assert.equal(host.imageCapture.choose(stored.reference), true);
  const used = await answerWith(host, host.imageCapture.answer("button"));
  assert.equal(used.outcome?.kind, "completed");
  return stored.reference;
}

/** The store of the room's kept sessions, as stored. */
const keptOf = (at: Browser, room?: "debug") => (room === "debug" ? at.innerRooms : at.innerKept);

/** Whether the room's kept session names `reference`, and whether that store holds its bytes. */
async function keptPhoto(at: Browser, reference: string, room?: "debug") {
  const store = keptOf(at, room);
  const kept = await store.session(SCOPE);
  return {
    named: kept !== null && JSON.stringify(kept).includes(reference),
    stored: (await store.media.get(SCOPE, reference)) !== null,
  };
}

/** What a fresh page of the room continues: the question it shows, and whether `reference` displays. */
async function reload(context: TestContext, at: Browser, reference: string, room?: "debug") {
  const { host, close } = await opened(context, at, KEEP, room);
  assert.equal(host.activation.value, "continue");
  await host.activate();
  await until(() => host.session.value?.state.status === "waiting", "Continue did not run");
  const question = ["Later", "Kept"].find((text) => said(host).includes(text)) ?? "image";
  host.resolveAsset(reference);
  await settle();
  const shown = host.resolveAsset(reference) !== null;
  close();
  return { question, shown };
}

for (const room of [undefined, "debug"] as const) {
  test(`${room ?? "normal"} room: a session whose new photo cannot be stored keeps the point kept before`, async (context) => {
    stubBrowser(context);
    for (const refused of [true, false]) {
      const at = browser();
      at.writes[room === "debug" ? "rooms" : "kept"] = refused ? "refuse" : "store";
      const { host, close } = await opened(context, at, KEEP, room);
      await host.activate();
      const reference = await answerImage(host);
      await until(() => said(host).includes("Kept"), "the next question did not show");
      await settle();
      close();
      const kept = await keptPhoto(at, reference, room);
      assert.equal(kept.named, !refused, "the kept session names the photo");
      assert.equal(kept.stored, !refused);
      assert.deepEqual(
        await reload(context, at, reference, room),
        refused ? { question: "image", shown: false } : { question: "Kept", shown: true },
      );
    }
  });
}

test("a photo already kept counts as stored, so keeping after a reload goes on to the later point", async (context) => {
  stubBrowser(context);
  const at = browser();
  const first = await opened(context, at, KEEP);
  await first.host.activate();
  const reference = await answerImage(first.host);
  await until(() => said(first.host).includes("Kept"), "the next question did not show");
  await settle();
  first.close();
  // After the reload, Continue holds the photo as session media again; keeping inserts it once more, which the store
  // refuses as a duplicate of what it keeps.
  const second = await opened(context, at, KEEP);
  await second.host.activate();
  await until(() => said(second.host).includes("Kept"), "Continue did not run");
  const answered = submitPlayerRuntimeComposer(second.host.session.value!, "on");
  assert.ok(answered);
  second.host.update(answered.session);
  await until(() => said(second.host).includes("Later"), "the later question did not show");
  await settle();
  second.close();
  assert.deepEqual(await keptPhoto(at, reference), { named: true, stored: true });
  assert.deepEqual(await reload(context, at, reference), { question: "Later", shown: true });
});

test("a debug-room photo stored by an attempt that then failed counts as stored", async (context) => {
  stubBrowser(context);
  const at = browser();
  at.writes.rooms = "commitThenFail";
  const { host, close } = await opened(context, at, KEEP, "debug");
  await host.activate();
  const reference = await answerImage(host);
  await until(() => said(host).includes("Kept"), "the next question did not show");
  await settle();
  close();
  assert.deepEqual(await keptPhoto(at, reference, "debug"), { named: true, stored: true });
  assert.deepEqual(await reload(context, at, reference, "debug"), {
    question: "Kept",
    shown: true,
  });
});

test("Debug on over a debug room that cannot be replaced keeps the session only with its photo stored there", async (context) => {
  stubBrowser(context);
  for (const variant of ["shown", "never read", "replaced"] as const) {
    const at = browser();
    // The script has a debug room already, and a photo it saved.
    (await opened(context, at, LOADED, "debug")).close();
    const saving = await opened(context, at, SAVE);
    await saving.host.activate();
    const reference = await answerImage(saving.host);
    await until(() => said(saving.host).includes("Saved"), "the save did not finish");
    await settle();
    saving.close();
    assert.equal(await at.innerRooms.media.get(SCOPE, reference), null);
    // A fresh page's session loads the photo's reference; it shows the photo, or never reads it.
    const { host } = await opened(context, at, LOADED);
    await host.activate();
    await until(() => said(host).includes("Loaded"), "the session did not run");
    if (variant === "shown") {
      host.resolveAsset(reference);
      await until(() => host.resolveAsset(reference) !== null, "the photo did not show");
    }
    at.refuseDiscard.rooms = variant !== "replaced";
    host.setDebugMode(true);
    await until(() => host.rooms.current.value === "debug", "Debug did not go on");
    await until(async () => (await at.innerRooms.session(SCOPE)) !== null, "nothing was kept");
    await settle();
    assert.deepEqual(
      await keptPhoto(at, reference, "debug"),
      { named: true, stored: true },
      variant,
    );
  }
});

for (const releaseAfterReset of [false, true]) {
  test(`a saved photo's thumbnail read released ${releaseAfterReset ? "after" : "before"} Reset leaves its bytes in the room once the source saves it`, async (context) => {
    stubBrowser(context);
    const at = browser();
    const first = await opened(context, at, SAVE, "debug");
    await first.host.activate();
    const reference = await answerImage(first.host);
    await until(() => said(first.host).includes("Saved"), "the save did not finish");
    await settle();
    first.close();
    // The next script saves that reference as text once its button is pressed.
    const source = compilePlayerProject(
      `showButton "Save"\nsave "${reference}" as "copy"\nlet w = askText("Done")\nexit`,
    ).plan!;
    const { host } = await opened(context, at, source, "debug");
    at.roomRead.arm();
    assert.equal(host.savedPhoto(reference).state, "loading");
    await until(() => at.roomRead.reached === 1, "the thumbnail was not read");
    if (!releaseAfterReset) {
      at.roomRead.release();
      await settle();
    }
    await host.rooms.resetDebug();
    await until(
      () => host.session.value?.state.status === "waiting",
      "the new session did not run",
    );
    if (releaseAfterReset) {
      at.roomRead.release();
      await settle();
    }
    const pressed = activatePlayerRuntimeButton(host.session.value!);
    assert.ok(pressed);
    host.update(pressed.session);
    await until(() => said(host).includes("Done"), "the save did not run");
    await settle();
    assert.deepEqual(await at.innerRooms.values(SCOPE).load(), [{ key: "copy", value: reference }]);
    assert.notEqual(await at.innerRooms.media.get(SCOPE, reference), null, "no bytes in the room");
    // A fresh debug page shows the saved photo.
    const fresh = await opened(context, at, source, "debug");
    fresh.host.savedPhoto(reference);
    await until(() => fresh.host.savedPhoto(reference).state === "ready", "the photo is missing");
  });
}
