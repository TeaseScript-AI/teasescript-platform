/*
 * Continuation ownership: an operation's handles, and every keep, import and restore route recorded against its
 * operation, with the family's controls.
 */

import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import test, { type TestContext } from "node:test";
import { effectScope, watch, type EffectScope } from "vue";
import {
  memoryKeptRoomStore,
  type KeptRoomStore,
  type KeptSessionStore,
} from "../../player/persistence/kept-sessions.js";
import { compilePlayerProject } from "../../player/runtime/compile-project.js";
import {
  StaleOperation,
  persistenceOwnership,
} from "../../player/persistence/persistence-ownership.js";
import { answerWith } from "../helpers/player/player-input.js";
import {
  createLocalScriptStorage,
  type ScriptStorageProvider,
} from "../../player/persistence/script-storage.js";
import type { StorageBundle } from "../../player/persistence/storage-transfer.js";
import {
  KEEP_WRITES,
  SAVED_DATA_SCRIPTS,
  type ImportedScript,
  LIFECYCLE,
  OWNERSHIP_MODES,
  RECORDED_STORES,
  SURFACES,
  UNOPERATED,
  MOVE_WRITES,
  OPERATED,
  OTHER_SCRIPT_WRITES,
  MOVES,
  POSTED,
  PRODUCERS,
  ROUTES,
  UNDRIVEN_ROUTES,
  UNHELD_AWAITS,
  VARIANTS,
  stale,
  type Move,
  type Variant,
  type VariantName,
} from "../helpers/player/plan-json-family.js";
import {
  CapturedMediaStore,
  isWellFormedCapturedMediaReference,
  type CapturedMediaRecord,
} from "../../player/media/captured-media.js";
import type { PlayerBridge } from "../../player/runtime/player-bridge.js";
import type { InstructionPlan } from "../../src/index.js";
import { FakeMediaRepository } from "../helpers/player/fake-media-repository.js";
import { readForImport } from "../helpers/player/transfer-read.js";
import type { SessionTransfer } from "../../player/persistence/session-transfer.js";
import {
  KeepHost,
  browserSavedData,
  stubBrowser,
  SCOPE,
  browser,
  planWrites,
  faults,
  writesOn,
  held,
  prepareOn,
  page,
  mount,
  tasks,
  until,
  ASKS,
  prepareAgain,
  ASKS_OTHER,
} from "../helpers/player/keep-host.js";

/*
 * Continuation ownership (`player/persistence/persistence-ownership.ts`), closed at admission: an operation reaches its stores and
 * the host only through its ownership's handles, which admit no call once it is stale. The family is generated from the
 * descriptor's variants (`VARIANTS`): each operation on each route it can take, with the fixtures that reach its calls
 * (photos only the session uses, saved photos into a browser that has none, two of them, one another tab stored first,
 * a failed replacement over an older photo, each of the kept store's failures, the debug room). Unheld, each run makes
 * exactly its trace. Held at each call of it while the page moves on (`MOVES`), the calls up to the held one were
 * admitted before the move and must complete; no later one is admitted. One recorder takes every call of the kept
 * store, its photos, the saved values' provider, the media store, the debug rooms and the host: its admission, with the
 * store it went to and the async context that made it, and its settlement apart. It fails a call no context owns, and a
 * write in the move's context the move does not make itself (`MOVE_WRITES`). Every row also asserts that a stale
 * operation changes nothing of the page (activation, the loaded saved values and the stored files they name,
 * `savedDataRevision`, the notices, the importing mark, the room and the debug room's marks) but releasing its own
 * importing mark, that its failure is neither shown nor thrown, and that no rejection goes unhandled; a current one
 * goes on, and a current failure surfaces. Each read of the saved values gives values of its own, so a stale read's
 * values are seen if shown.
 */
test("an operation's handles admit each call while it is current, and none once it was stale", async () => {
  let current = true;
  const ownership = persistenceOwnership(() => current);
  assert.equal(
    ownership.commit(() => 1),
    1,
  );
  // An apply that awaits would go on after the commit's check: the type refuses one, and so does the run.
  const later = Promise.resolve();
  // @ts-expect-error -- `commit` takes no thenable apply.
  assert.throws(() => ownership.commit(() => later), TypeError);
  // @ts-expect-error -- nor an async one.
  assert.throws(() => ownership.commit(async () => {}), TypeError);
  // @ts-expect-error -- nor one that may return a thenable.
  assert.throws(() => ownership.commit(() => (later !== null ? later : 1)), TypeError);
  const reached: string[] = [];
  let finish = () => {};
  const values = ownership.values({
    scope: "s",
    load: async () => [],
    write: async () => {},
    replace: () => {
      reached.push("replace");
      return new Promise<void>((resolve) => (finish = resolve));
    },
    clear: async () => {
      reached.push("clear");
    },
  });
  // Admitted while current, a call completes after the operation went stale.
  const replacing = values.replace([]);
  current = false;
  finish();
  await replacing;
  assert.throws(() => values.clear(), StaleOperation);
  let applied = false;
  assert.throws(() => ownership.commit(() => (applied = true)), StaleOperation);
  assert.equal(applied, false);
  assert.deepEqual(reached, ["replace"]);
  // Once stale, for good.
  current = true;
  assert.equal(ownership.current(), false);
});

test("a promotion admitted before its operation went stale stores the photo, but marks nothing durable after", async () => {
  let current = true;
  const ownership = persistenceOwnership(() => current);
  let finish = () => {};
  const repository = new FakeMediaRepository();
  const add = repository.add.bind(repository);
  repository.add = async (record) => {
    await new Promise<void>((resolve) => (finish = resolve));
    return add(record);
  };
  const media = new CapturedMediaStore(repository, { create: () => "url", revoke: () => {} }, "s");
  const { reference } = media.add("image", new Blob([PNG], { type: "image/png" }));
  const promoting = media.promote([reference], ownership);
  current = false;
  finish();
  await assert.rejects(promoting, StaleOperation);
  // The admitted insert stored the photo; the stale operation did not mark it as stored, so a keep still takes it.
  assert.equal(repository.size, 1);
  assert.equal(media.sessionRecords([reference]).length, 1);
});

const OPERATION = "operation";
const MOVE = "move";
const contexts = new AsyncLocalStorage<string>();

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
// A session with a photo only it uses, one that saves its photo, and one that saves two.
const PHOTO_PLAN = compilePlayerProject(
  'let picture: string = askImage(hint: "Add an image")\nlet a = askText(hint: "One")\nsay "Got ${a}.", instant\nexit',
).plan!;
const SAVED_PHOTO_PLAN = compilePlayerProject(
  'let picture: string = askImage(hint: "Add an image")\nsave picture as "photo"\nlet a = askText(hint: "One")\nsay "Got ${a}.", instant\nexit',
).plan!;
const TWO_PHOTOS_PLAN = compilePlayerProject(
  'let first: string = askImage(hint: "First")\nsave first as "first"\nlet second: string = askImage(hint: "Second")\nsave second as "second"\nlet a = askText(hint: "One")\nsay "Got ${a}.", instant\nexit',
).plan!;

// Two photos only the session uses: a debug room's keep promotes both.
const TWO_SESSION_PHOTOS_PLAN = compilePlayerProject(
  'let first: string = askImage(hint: "First")\nlet second: string = askImage(hint: "Second")\nlet a = askText(hint: "One")\nsay "Got ${a}.", instant\nexit',
).plan!;

/**
 * A call of a recorded store or of the host: its admission, as the store received it, with the store it went to and
 * the async context that made it, fixed then; and its settlement, recorded apart once the store's promise settles.
 */
interface RecordedCall {
  readonly name: string;
  /** The store the call went to: the kept store, the debug rooms, a room's values, the provider, the media store. */
  readonly destination: string;
  readonly by: string | undefined;
  readonly write: boolean;
  settled: "resolved" | "rejected" | null;
  /** The scope a kept-store or room call names, or the namespace of a photo it stores. */
  readonly scope?: string;
  /** For a publication of a kept session: where its events begin (0 for a first save), and its state. */
  readonly eventsFrom?: number;
  readonly snapshotJson?: string;
  /** For a photo stored: its reference. */
  readonly reference?: string;
  /** For the host's capture of a session to keep: the state it gave, once it replied. */
  capture?: { readonly snapshotJson: string; readonly eventsThrough: number };
}

/** The contexts a call of these runs may have: the operation's, the move's, or none for the page's lifecycle. */
const CONTEXTS = new Set<string | undefined>([OPERATION, MOVE, undefined]);

/** Each call no recognized context owns: an unknown label, or none outside the page's lifecycle. */
function unowned(calls: readonly RecordedCall[]): string[] {
  return calls
    .filter(
      (made) =>
        !CONTEXTS.has(made.by) || (made.by === undefined && !Object.hasOwn(LIFECYCLE, made.name)),
    )
    .map((made) => `${made.by ?? "none"}:${made.name}`);
}

/**
 * The move's kept-store and room writes no keep of the session it started accounts for. The ledger is the host's own
 * replies to the move's captures: each save must consume one, with its state, in the scope, its events beginning at 0
 * right after a discard and within the capture otherwise; a discard comes only before a first save, a photo only of a
 * captured state, and a room's creation once. A write besides fails, whatever it stores.
 */
function unledgered(calls: readonly RecordedCall[]): string[] {
  const stray: string[] = [];
  const entries = calls.flatMap((made, index) =>
    made.by === MOVE && made.capture !== undefined ? [{ index, ...made.capture, used: false }] : [],
  );
  for (const store of ["kept.", "rooms."]) {
    let discarded = false;
    let created = false;
    calls.forEach((made, index) => {
      if (made.by !== MOVE || !made.write || !made.name.startsWith(store)) return;
      const method = made.name.slice(store.length);
      const where = `${made.name} (call ${index})`;
      if (made.scope !== SCOPE) stray.push(`${where} in scope ${made.scope}`);
      else if (method === "media.add") {
        const reference = made.reference ?? "";
        if (
          !entries.some(
            (entry) => !entry.used && entry.index < index && entry.snapshotJson.includes(reference),
          )
        )
          stray.push(`${where}: a photo no capture shows`);
      } else if (method === "create") {
        if (created) stray.push(`${where}: a second room`);
        created = true;
      } else if (method === "discard" || method === "discardSession") {
        if (discarded) stray.push(`${where}: a second discard`);
        discarded = true;
      } else if (method === "publish") {
        const entry = entries.find(
          (candidate) =>
            !candidate.used &&
            candidate.index < index &&
            candidate.snapshotJson === made.snapshotJson,
        );
        if (entry === undefined)
          stray.push(`${where}: no capture of the move's session gives its state`);
        else {
          entry.used = true;
          const from = made.eventsFrom ?? -1;
          if ((from === 0) !== discarded || from > entry.eventsThrough)
            stray.push(
              `${where}: its events from ${from}, ${discarded ? "after" : "without"} a discard`,
            );
        }
        discarded = false;
      } else stray.push(`${where}: no keep's write`);
    });
    if (discarded) stray.push(`${store}discard, no save after it`);
  }
  return stray;
}

/** The class of `key` of a store recorded as `surface`; a surface or method no class names fails the run. */
function methodClass(surface: string, key: string): string | undefined {
  const classes: Readonly<Record<string, string>> | undefined = Object.entries(SURFACES).find(
    ([name]) => name === surface,
  )?.[1];
  assert.ok(classes !== undefined, `the surface ${surface} is classified`);
  // Its own entries alone: a name every object inherits, such as `toString`, is no class.
  return Object.hasOwn(classes, key) ? classes[key] : undefined;
}

/**
 * Every store of `at` behind one recorder, installed before its pages mount; `hold` holds the first call of a name
 * made in a context (a host request once it is posted, a store call before it runs) until `release()`.
 */
function recorder(context: TestContext, at: FamilyBrowser) {
  const calls: RecordedCall[] = [];
  let armed: { readonly name: string; readonly by: string | null; skip: number } | null = null;
  let reached = () => {};
  let gate: Promise<void> = Promise.resolve();
  let open = () => {};
  let introduced: string | null = null;
  const failingHost = new Set<string>();
  const take = (name: string): Promise<void> | null => {
    if (armed === null || armed.name !== name || (contexts.getStore() ?? null) !== armed.by)
      return null;
    if (armed.skip > 0) {
      armed.skip -= 1;
      return null;
    }
    armed = null;
    reached();
    return gate;
  };
  const record = (name: string, write: boolean, args: readonly unknown[] = []): RecordedCall => {
    const [first, second] = args;
    const media = name.includes(".media.");
    const photo =
      media && typeof first === "object" && first !== null && "reference" in first ? first : null;
    const update =
      name.endsWith(".publish") && typeof second === "object" && second !== null ? second : null;
    const made: RecordedCall = {
      name,
      destination: name.slice(0, name.lastIndexOf(".")),
      by: contexts.getStore(),
      write,
      settled: null,
      ...(typeof first === "string" && !media ? { scope: first } : {}),
      ...(photo !== null && "namespace" in photo && typeof photo.namespace === "string"
        ? { scope: photo.namespace }
        : {}),
      ...(photo !== null && typeof photo.reference === "string"
        ? { reference: photo.reference }
        : {}),
      ...(update !== null && "eventsFrom" in update && typeof update.eventsFrom === "number"
        ? { eventsFrom: update.eventsFrom }
        : {}),
      ...(update !== null && "snapshotJson" in update && typeof update.snapshotJson === "string"
        ? { snapshotJson: update.snapshotJson }
        : {}),
    };
    calls.push(made);
    return made;
  };
  /** Records how `result`, the store's own promise, settles, and hands it on as it is. */
  const settles = <T>(made: RecordedCall, result: T): T => {
    if (result instanceof Promise)
      result.then(
        () => (made.settled = "resolved"),
        () => (made.settled = "rejected"),
      );
    else made.settled = "resolved";
    return result;
  };
  const instrument = <T extends object>(target: T, surface: string): T => {
    const nested = new Map<string, unknown>();
    return new Proxy(target, {
      get(object, key) {
        // EVIDENCE: invariant: the recorded stores are plain objects, read by their methods' and fields' names.
        const value: unknown = (object as Record<PropertyKey, unknown>)[key];
        if (typeof key !== "string" || key === "then") return value;
        const kind = methodClass(surface, key);
        // A field of a fake beside its interface, such as the repository's records; a method must be classified.
        if (kind === undefined) {
          assert.ok(typeof value !== "function", `${surface}.${key} is classified`);
          return value;
        }
        if (kind === "field") return value;
        if (kind === "store" && typeof value === "object" && value !== null) {
          if (!nested.has(key)) nested.set(key, instrument(value, `${surface}.${key}`));
          return nested.get(key);
        }
        assert.ok(typeof value === "function", `${surface}.${key} is a method`);
        const name = `${surface}.${key}`;
        return (...args: unknown[]) => {
          const made = record(name, kind === "write", args);
          const run = () => {
            const result: unknown = value.apply(object, args);
            // A debug room's saved values are a provider of their own.
            return kind === "store" && typeof result === "object" && result !== null
              ? settles(made, instrument(result, name))
              : settles(made, result);
          };
          const held = take(name);
          return held === null ? run() : held.then(run);
        };
      },
    });
  };
  at.kept = instrument(at.kept, "kept");
  at.provider = instrument(at.provider, "provider");
  at.repository = instrument(at.repository, "repository");
  at.rooms = instrument(at.rooms, "rooms");
  return {
    calls,
    /** The host's requests of `bridge`'s page, recorded from now on. */
    watchHost(bridge: PlayerBridge) {
      const request = bridge.client.request.bind(bridge.client);
      context.mock.method(bridge.client, "request", (...args: Parameters<typeof request>) => {
        const name = `host.${args[0]}`;
        const made = record(name, false);
        const by = contexts.getStore();
        const held = take(name);
        // The host's reply lost on the way, once, where the fixture asks for it.
        const reply = settles(
          made,
          failingHost.delete(args[0])
            ? Promise.reject(new Error("The request failed."))
            : request(...args),
        );
        // The move's own captures: the ledger its saves consume.
        if (args[0] === "captureKeep" && by === MOVE)
          reply.then(
            (result) => {
              const capture: unknown = result.result;
              if (
                typeof capture === "object" &&
                capture !== null &&
                "kind" in capture &&
                capture.kind === "captured" &&
                "snapshotJson" in capture &&
                typeof capture.snapshotJson === "string" &&
                "eventsThrough" in capture &&
                typeof capture.eventsThrough === "number"
              )
                made.capture = {
                  snapshotJson: capture.snapshotJson,
                  eventsThrough: capture.eventsThrough,
                };
            },
            () => {},
          );
        if (args[0] === "restoreKept" && by === OPERATION)
          reply.then(
            (result) => {
              if (typeof result.session === "string") introduced = result.session;
            },
            () => {},
          );
        return held === null
          ? reply
          : reply.then(
              async (result) => (await held, result),
              async (error: unknown) => {
                await held;
                throw error;
              },
            );
      });
    },
    /** Holds the call `name` made in context `by` (`null`: none), after `skip` such calls. */
    hold(name: string, skip = 0, by: string | null = OPERATION) {
      armed = { name, by, skip };
      gate = new Promise<void>((resolve) => (open = resolve));
      return new Promise<void>((resolve) => (reached = resolve));
    },
    release: () => open(),
    /** Fails the next request of `op` to the host. */
    failHost: (op: string) => void failingHost.add(op),
    /** The session the operation's restore introduced in the host, if any. */
    introduced: () => introduced,
  };
}

/** The kept-store and saved-values calls the family can make fail once, as a full or refusing storage does. */
type Failing = "kept.discard" | "kept.media.add" | "provider.replace" | "repository.add:exists";

/** A browser's local storage, in memory. */
class MemoryLocalStorage implements Storage {
  readonly #items = new Map<string, string>();
  get length() {
    return this.#items.size;
  }
  clear(): void {
    this.#items.clear();
  }
  getItem(key: string): string | null {
    return this.#items.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.#items.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.#items.delete(key);
  }
  setItem(key: string, value: string): void {
    this.#items.set(key, value);
  }
}

/** A media store another tab of the browser may have stored a photo in first, which makes `add` refuse it. */
class SharedTabRepository extends FakeMediaRepository {
  readonly #storedElsewhere: () => boolean;
  constructor(storedElsewhere: () => boolean) {
    super();
    this.#storedElsewhere = storedElsewhere;
  }
  override async add(record: CapturedMediaRecord) {
    if (this.#storedElsewhere()) {
      await super.add(record);
      throw new DOMException("", "ConstraintError");
    }
    return super.add(record);
  }
}

/**
 * One browser for the family: `browser()`'s, whose saved values give each read a value of its own, with debug rooms,
 * calls that fail once on request (`failing`), and refused discards of a debug room's session (`roomsDiscardFailing`).
 */
function familyBrowser(route: "plain" | "captured" = "captured") {
  const base = browser();
  const rooms: KeptRoomStore = memoryKeptRoomStore();
  const failing = new Set<Failing>();
  const state = Object.assign(base.state, { roomsDiscardFailing: 0, route });
  const fails = (name: Failing) => failing.delete(name);
  type Entries = Parameters<ScriptStorageProvider["replace"]>[0];
  let stored: Entries = [];
  let reads = 0;
  const provider: ScriptStorageProvider = {
    scope: SCOPE,
    load: async () => [...stored, { key: "read", value: ++reads }],
    write: async (key, value) => {
      stored = [...stored.filter((entry) => entry.key !== key), { key, value }];
    },
    replace: async (entries) => {
      if (fails("provider.replace"))
        throw new DOMException("The storage is full.", "QuotaExceededError");
      stored = entries.filter((entry) => entry.key !== "read");
    },
    clear: async () => {
      stored = [];
    },
  };
  const inner = base.kept;
  const kept: KeptSessionStore = {
    session: (scope) => inner.session(scope),
    publish: (scope, update) => inner.publish(scope, update),
    async discard(scope) {
      if (fails("kept.discard"))
        throw new DOMException("The storage is full.", "QuotaExceededError");
      return inner.discard(scope);
    },
    media: {
      get: (namespace, reference) => inner.media.get(namespace, reference),
      async add(record) {
        if (fails("kept.media.add"))
          throw new DOMException("The storage is full.", "QuotaExceededError");
        return inner.media.add(record);
      },
      delete: (namespace, reference) => inner.media.delete(namespace, reference),
      listReferences: (namespace) => inner.media.listReferences(namespace),
    },
  };
  const repository = new SharedTabRepository(() => fails("repository.add:exists"));
  const discardSession = rooms.discardSession.bind(rooms);
  rooms.discardSession = async (scope) => {
    if (state.roomsDiscardFailing > 0)
      throw new DOMException("The storage is full.", "QuotaExceededError");
    return discardSession(scope);
  };
  // Other scripts' saved data, in this browser's local storage, as the saved-data host keeps them.
  const local = new MemoryLocalStorage();
  const otherRepository = new FakeMediaRepository();
  const savedData = browserSavedData(local, otherRepository, undefined, {
    holdLive: () => ({ granted: Promise.resolve("held"), release: () => {} }),
    whenIdle: async (_scope, work) => (await work(), true),
  });
  const otherValues = async (scope: string) => createLocalScriptStorage(local, scope).load();
  // The kept store as it is, beside the recorder's: a control reads it without a call of its own.
  return {
    ...base,
    provider,
    kept,
    rawKept: kept,
    rawProvider: provider,
    repository,
    // The stores as they are, past the recorder, for a check after the run: the page's photos and the other script's.
    rawRepository: repository,
    otherRepository,
    rooms,
    failing,
    state,
    savedData,
    otherValues,
  };
}
type FamilyBrowser = ReturnType<typeof familyBrowser>;

/** The page as its player sees it, and each change of it with the async context that made it. */
function pageLog(host: KeepHost) {
  const snapshot = () => ({
    activation: host.activation.value,
    savedValues: host.scriptStorageOptions().scriptStorage ?? null,
    savedDataRevision: host.savedDataRevision.value,
    notices: host.notices.value.map((notice) => notice.key),
    importing: !host.canImportSavedData.value,
    room: host.rooms.current.value,
    debugSession: host.rooms.debugSessionExists.value,
    debugData: host.rooms.debugHasData.value,
    // The stored files a Start names: the photos the page knows among its saved values.
    storedFiles: host.scriptStorageOptions().storedFiles ?? null,
  });
  type Snapshot = ReturnType<typeof snapshot>;
  const changes: {
    readonly by: string | undefined;
    readonly from: Snapshot;
    readonly to: Snapshot;
  }[] = [];
  let last = snapshot();
  // Its own scope: the log goes on after the page closes.
  const scope = effectScope(true);
  scope.run(() =>
    watch(
      () => JSON.stringify(snapshot()),
      () => {
        const next = snapshot();
        changes.push({ by: contexts.getStore(), from: last, to: next });
        last = next;
      },
      { flush: "sync" },
    ),
  );
  return { snapshot, changes, stop: () => scope.stop() };
}

/** Lets `host`'s session take a fixture photo at its question, then waits for its next one. */
async function answerPhoto(host: KeepHost): Promise<string> {
  await until(() => host.session.value?.state.status === "waiting", "the session did not ask");
  const stored = await host.images.store(new File([PNG], "photo.png"), { types: null, mime: null });
  assert.ok("reference" in stored, "the photo was not stored");
  // Chosen once the session asks for it: after an earlier photo, its next question comes a step later.
  await until(
    () => host.imageCapture.choose(stored.reference),
    "the session did not ask for a photo",
  );
  const used = await answerWith(host, host.imageCapture.answer("button"));
  assert.equal(used.outcome?.kind, "completed");
  return stored.reference;
}

/** Waits until `at` kept a session whose state uses every one of `references`, and its page is done with it. */
async function keptWith(at: FamilyBrowser, references: readonly string[]) {
  await until(
    () =>
      at.published.some((update) =>
        references.every((reference) => update.snapshotJson.includes(reference)),
      ),
    "the session was not kept with its photos",
  );
  for (let turn = 0; turn < 4; turn++) await tasks();
}

/** A page of `at` whose session of `plan` took its photos and asks its last question, kept with them. */
async function photoSession(
  context: TestContext,
  at: FamilyBrowser,
  plan: InstructionPlan = PHOTO_PLAN,
  photos = 1,
) {
  const opened = await page(context, at, plan);
  await opened.host.activate();
  const references: string[] = [];
  for (let photo = 0; photo < photos; photo++) references.push(await answerPhoto(opened.host));
  await keptWith(at, references);
  return { ...opened, references };
}

/** The transfer of a session of `plan` exported from a browser of its own, which then closes. */
async function exported(context: TestContext, plan: InstructionPlan, photos = 1) {
  const source = familyBrowser();
  const exporting = await photoSession(context, source, plan, photos);
  const { transfer } = await exporting.host.exportSession();
  exporting.scope.stop();
  await tasks();
  return transfer;
}

/** An operation of a producer, prepared on its page; `start` begins it, in the operation's context. */
interface Operation {
  readonly host: KeepHost;
  readonly scope: EffectScope;
  readonly plan: InstructionPlan;
  start(): Promise<void>;
}
/** What a driver is given: the host's recorder, and the page's hiding. */
interface Fixture {
  readonly watchHost: (bridge: PlayerBridge) => void;
  readonly hide: () => void;
  readonly failHost: (op: string) => void;
}
type Driver = (context: TestContext, at: FamilyBrowser, fixture: Fixture) => Promise<Operation>;

/** A Continue's restore on a page of `at` of `plan`, which `at` keeps a session of. */
async function restoreOn(
  context: TestContext,
  at: FamilyBrowser,
  { watchHost }: Fixture,
  plan: InstructionPlan,
  room?: "debug",
): Promise<Operation> {
  const { host, scope } = await mount(context, at, undefined, room);
  watchHost(await host.bridge);
  const token = await held(host, plan);
  return {
    host,
    scope,
    plan,
    start: () =>
      host.prepareScript(token, {
        plan: token,
        options: () => ({ ...host.scriptStorageOptions(), ...host.temporalCapture() }),
      }),
  };
}

/** An import of `transfer` on a page of `at` of `plan`; `before` runs once it was reviewed. */
async function importOn(
  context: TestContext,
  at: FamilyBrowser,
  { watchHost }: Fixture,
  plan: InstructionPlan,
  transfer: SessionTransfer,
  before: () => void = () => {},
): Promise<Operation> {
  const { host, scope } = await page(context, at, plan);
  const stored = at.repository.size;
  const review = await host.reviewSessionImport(await readForImport(host, transfer));
  // The review stores no photo: the import's own calls do.
  assert.equal(at.repository.size, stored, "the review stored a photo");
  watchHost(await host.bridge);
  before();
  return { host, scope, plan, start: () => host.importSession(review) };
}

/** A first save of a session of `plan` with its photo, its earlier saves refused; `forget` cannot write its state. */
async function keepOn(
  context: TestContext,
  at: FamilyBrowser,
  { watchHost, hide }: Fixture,
  first: "first" | "incremental" | "forget",
  room?: "debug",
  plan: InstructionPlan = PHOTO_PLAN,
  photos = 1,
): Promise<Operation> {
  const { host, scope } = await page(context, at, plan);
  watchHost(await host.bridge);
  if (first !== "incremental") at.state.failing = Number.MAX_SAFE_INTEGER;
  await host.activate();
  const references: string[] = [];
  for (let photo = 0; photo < photos; photo++) references.push(await answerPhoto(host));
  await keptWith(at, references);
  if (room === "debug") {
    // Play goes on in the debug room, whose saves fail at their first step until the operation.
    at.state.roomsDiscardFailing = Number.MAX_SAFE_INTEGER;
    host.setDebugMode(true);
    await until(() => host.rooms.current.value === "debug", "the page did not open the debug room");
    hide();
    for (let turn = 0; turn < 8; turn++) await tasks();
    at.state.roomsDiscardFailing = 0;
  }
  at.state.failing = 0;
  return {
    host,
    scope,
    plan,
    start: async () => {
      if (first === "forget") faults.nextSnapshot = true;
      hide();
    },
  };
}

/** Another script of the browser, which a saved-data import may write. */
const OTHER_SCOPE = "development-package:other";
/** An exported photo of a saved-data bundle, under the reference its values hold. */
const BUNDLE_PHOTO = "captured-media:11111111-1111-4111-8111-111111111111:1";
/** Saved data of `scopes` as an export of them holds it: each with a photo and a score. */
function bundleOf(scopes: readonly string[]): StorageBundle {
  return {
    scripts: scopes.map((scope) => ({
      scope,
      name: null,
      photos: [BUNDLE_PHOTO],
      entries: [
        { key: "photo", value: BUNDLE_PHOTO },
        { key: "score", value: 3 },
      ],
    })),
    images: [{ reference: BUNDLE_PHOTO, bytes: PNG }],
  };
}

const SCOPE_OF: Readonly<Record<ImportedScript, string>> = { shown: SCOPE, other: OTHER_SCOPE };
/** The saved-data import `name` on a page of `at`: the scripts it declares, in the room its route names. */
const savedDataImportOf = (
  context: TestContext,
  at: FamilyBrowser,
  fixture: Fixture,
  name: keyof typeof SAVED_DATA_SCRIPTS,
) =>
  savedDataImportOn(
    context,
    at,
    fixture,
    SAVED_DATA_SCRIPTS[name].imports.map((script) => SCOPE_OF[script]),
    VARIANTS[name].route === "debug" ? "debug" : undefined,
  );

/** A saved-data import of `scopes` on a page of `at`, in its normal room or the debug room. */
async function savedDataImportOn(
  context: TestContext,
  at: FamilyBrowser,
  { watchHost }: Fixture,
  scopes: readonly string[],
  room?: "debug",
): Promise<Operation> {
  const { host, scope } = await mount(context, at, undefined, room);
  await prepareOn(host, PHOTO_PLAN);
  const review = await host.reviewSavedDataImport(bundleOf(scopes));
  watchHost(await host.bridge);
  return {
    host,
    scope,
    plan: PHOTO_PLAN,
    start: () => host.importSavedData(review, new Set(scopes)),
  };
}

/** Each variant of the descriptor on its real path, up to its start. */
const VARIANT_DRIVERS: Record<VariantName, Driver> = {
  async "restoreKept captured sessionPhoto"(context, at, fixture) {
    (await photoSession(context, at)).scope.stop();
    await tasks();
    return restoreOn(context, at, fixture, PHOTO_PLAN);
  },
  async "restoreKept plain sessionPhoto"(context, at, fixture) {
    (await photoSession(context, at)).scope.stop();
    await tasks();
    return restoreOn(context, at, fixture, PHOTO_PLAN);
  },
  async "restoreKept debug sessionPhoto"(context, at, fixture) {
    // A session kept in the debug room: copied there, then saved by the debug room.
    const { host, scope } = await photoSession(context, at);
    host.setDebugMode(true);
    await until(() => host.rooms.current.value === "debug", "the page did not open the debug room");
    fixture.hide();
    await until(() => host.activation.value === null, "the debug session did not go on");
    for (let turn = 0; turn < 8; turn++) await tasks();
    assert.ok((await at.rooms.session(SCOPE)) !== null, "the debug room keeps a session");
    scope.stop();
    await tasks();
    return restoreOn(context, at, fixture, PHOTO_PLAN, "debug");
  },
  async "planText captured sessionPhoto"(context, at, fixture) {
    return importOn(context, at, fixture, PHOTO_PLAN, await exported(context, PHOTO_PLAN));
  },
  async "planText plain sessionPhoto"(context, at, fixture) {
    return importOn(context, at, fixture, PHOTO_PLAN, await exported(context, PHOTO_PLAN));
  },
  async "planText captured savedPhoto"(context, at, fixture) {
    return importOn(
      context,
      at,
      fixture,
      SAVED_PHOTO_PLAN,
      await exported(context, SAVED_PHOTO_PLAN),
    );
  },
  async "planText captured twoSavedPhotos"(context, at, fixture) {
    const transfer = await exported(context, TWO_PHOTOS_PLAN, 2);
    return importOn(context, at, fixture, TWO_PHOTOS_PLAN, transfer);
  },
  async "planText captured confirmedPhoto"(context, at, fixture) {
    const transfer = await exported(context, SAVED_PHOTO_PLAN);
    return importOn(context, at, fixture, SAVED_PHOTO_PLAN, transfer, () =>
      at.failing.add("repository.add:exists"),
    );
  },
  async "planText captured failedReplace"(context, at, fixture) {
    // The browser keeps saved values with a photo of an earlier import, which the importing page does not hold.
    const earlier = await importOn(
      context,
      at,
      { ...fixture, watchHost: () => {} },
      SAVED_PHOTO_PLAN,
      await exported(context, SAVED_PHOTO_PLAN),
    );
    await earlier.start();
    earlier.scope.stop();
    await tasks();
    const transfer = await exported(context, SAVED_PHOTO_PLAN);
    return importOn(context, at, fixture, SAVED_PHOTO_PLAN, transfer, () =>
      at.failing.add("provider.replace"),
    );
  },
  async "planText captured discardFails"(context, at, fixture) {
    // The browser keeps a session of its own, which the import cannot replace.
    (await photoSession(context, at)).scope.stop();
    await tasks();
    const transfer = await exported(context, PHOTO_PLAN);
    return importOn(context, at, fixture, PHOTO_PLAN, transfer, () =>
      at.failing.add("kept.discard"),
    );
  },
  async "planText captured photoAddFails"(context, at, fixture) {
    const transfer = await exported(context, PHOTO_PLAN);
    return importOn(context, at, fixture, PHOTO_PLAN, transfer, () =>
      at.failing.add("kept.media.add"),
    );
  },
  async "planText captured planTextFails"(context, at, fixture) {
    const transfer = await exported(context, PHOTO_PLAN);
    return importOn(context, at, fixture, PHOTO_PLAN, transfer, () => fixture.failHost("planText"));
  },
  async "planText captured publishFails"(context, at, fixture) {
    const transfer = await exported(context, PHOTO_PLAN);
    return importOn(context, at, fixture, PHOTO_PLAN, transfer, () => (at.state.failing = 1));
  },
  "captureKeep captured first": (context, at, fixture) => keepOn(context, at, fixture, "first"),
  "captureKeep captured incremental": (context, at, fixture) =>
    keepOn(context, at, fixture, "incremental"),
  "captureKeep captured forget": (context, at, fixture) => keepOn(context, at, fixture, "forget"),
  "captureKeep debug first": (context, at, fixture) =>
    keepOn(context, at, fixture, "first", "debug"),
  "captureKeep debug twoPhotos": (context, at, fixture) =>
    keepOn(context, at, fixture, "first", "debug", TWO_SESSION_PHOTOS_PLAN, 2),
  "savedDataImport captured shown": (context, at, fixture) =>
    savedDataImportOf(context, at, fixture, "savedDataImport captured shown"),
  "savedDataImport captured shownAndOther": (context, at, fixture) =>
    savedDataImportOf(context, at, fixture, "savedDataImport captured shownAndOther"),
  "savedDataImport debug ownScript": (context, at, fixture) =>
    savedDataImportOf(context, at, fixture, "savedDataImport debug ownScript"),
  "savedDataImport captured otherOnly": (context, at, fixture) =>
    savedDataImportOf(context, at, fixture, "savedDataImport captured otherOnly"),
  "savedDataImport plain photoNotStored": (context, at, fixture) =>
    savedDataImportOf(context, at, fixture, "savedDataImport plain photoNotStored"),
};

/** What each failing import says when it is current, and what it offers then. */
const CURRENT_FAILURES: Partial<
  Record<VariantName, { message: RegExp; offers: "start" | "continue" }>
> = {
  "planText captured failedReplace": { message: /Nothing was imported/, offers: "continue" },
  "planText captured discardFails": {
    message: /could not replace the session it kept/,
    offers: "continue",
  },
  "planText captured photoAddFails": { message: /could not keep the session/, offers: "start" },
  "planText captured planTextFails": { message: /could not keep the session/, offers: "start" },
  "planText captured publishFails": { message: /could not keep the session/, offers: "start" },
  "savedDataImport plain photoNotStored": {
    message: /its photos could not be stored/,
    offers: "start",
  },
};

/** The page of `operation` moves on as `move` says. */
async function moveOn(operation: Operation, move: Move) {
  if (move === "otherPlan") await prepareAgain(operation.host, ASKS_OTHER);
  else if (move === "samePlan") await prepareAgain(operation.host, operation.plan);
  else if (move === "room") {
    operation.host.setDebugMode(true);
    await until(
      () => operation.host.rooms.current.value === "debug",
      "the page did not open the debug room",
    );
  } else operation.scope.stop();
}

/** The occurrences of `trace` a row can hold: each call that is not posted, with how many of its name come before. */
function holdable(trace: readonly string[]) {
  return trace.flatMap((name, index) =>
    Object.hasOwn(POSTED, name)
      ? []
      : [{ index, name, skip: trace.slice(0, index).filter((made) => made === name).length }],
  );
}

/** Waits until `reached`, the held call `name`, arrives; fails with the calls made so far when it does not. */
async function reachedWithin(
  reached: Promise<void>,
  name: string,
  calls: readonly RecordedCall[],
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"missed">(
    (resolve) => (timer = setTimeout(resolve, 2_000, "missed")),
  );
  const arrived = await Promise.race([reached, deadline]);
  clearTimeout(timer);
  assert.notEqual(
    arrived,
    "missed",
    `${name} was not reached; the calls: ${calls
      .slice(-12)
      .map((made) => `${made.by ?? "-"}:${made.name}`)
      .join(" ")}`,
  );
}

/**
 * One run of `name`: unheld when `at` is null, else held at the trace's call `at` while its page moves as `move` says
 * (or does not, without one).
 */
async function ownershipRun(
  context: TestContext,
  name: VariantName,
  at: { readonly index: number; readonly name: string; readonly skip: number } | null,
  move: Move | null,
  // A control's own work once the run settled, before its checks: they must catch it.
  intrude?: (at: FamilyBrowser) => Promise<void>,
) {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  context.after(() => process.off("unhandledRejection", onUnhandled));
  const shown = stubBrowser(context);
  planWrites(
    context,
    PHOTO_PLAN,
    SAVED_PHOTO_PLAN,
    TWO_PHOTOS_PLAN,
    TWO_SESSION_PHOTOS_PLAN,
    ASKS_OTHER,
  );
  context.after(() => {
    faults.nextSnapshot = false;
    faults.planWrite = null;
  });
  const variant: Variant = VARIANTS[name];
  const browserAt = familyBrowser(variant.route === "plain" ? "plain" : "captured");
  const recorded = recorder(context, browserAt);
  const operation = await VARIANT_DRIVERS[name](context, browserAt, {
    watchHost: recorded.watchHost,
    hide: shown.hide,
    failHost: recorded.failHost,
  });
  const log = pageLog(operation.host);
  context.after(log.stop);
  const bridge = await operation.host.bridge;
  const callsAtStart = recorded.calls.length;
  const reached = at === null ? null : recorded.hold(at.name, at.skip);
  const done = contexts
    .run(OPERATION, () => operation.start())
    .then(
      () => ({ rejected: false as const }),
      (error: unknown) => ({ rejected: true as const, error }),
    );
  if (reached !== null) await reachedWithin(reached, at!.name, recorded.calls);
  const producer = variant.producer;
  const retires = move !== null && stale(producer, move, variant.route, variant.ownership) === true;
  // The page goes on with what the move prepared, where it can: its Start runs. An import under way holds Start back
  // until a room change takes the page over; a room change waits for the saved values' calls issued before it, so an
  // import held at one of them holds the room change too.
  // An import holds Start back while it runs, the session's and the saved data's alike.
  const anImport = producer === "planText" || producer === "savedDataImport";
  const moveWaits =
    anImport &&
    move === "room" &&
    (at!.name.startsWith("provider.") || at!.name.startsWith("repository."));
  const startsAnew =
    move !== null &&
    move !== "disposed" &&
    (producer === "restoreKept" || (anImport && move === "room" && !moveWaits));
  if (move !== null)
    await contexts.run(MOVE, async () => {
      await moveOn(operation, move);
      if (startsAnew) {
        await operation.host.activate();
        await until(
          () => operation.host.session.value !== null && operation.host.activation.value === null,
          "the moved-on page did not start",
        );
      }
      for (let turn = 0; turn < 4; turn++) await tasks();
    });
  const callsAtMark = recorded.calls.length;
  const changesAtMark = log.changes.length;
  const publishedAtMark = browserAt.published.length;
  const before = log.snapshot();
  recorded.release();
  const outcome = await done;
  for (let turn = 0; turn < 6; turn++) await tasks();
  await intrude?.(browserAt);
  const after = log.snapshot();
  const since = recorded.calls.slice(callsAtStart);
  // Every call from the operation's start is the operation's, the move's, or the page's lifecycle, which reaches no store.
  assert.deepEqual(unowned(since), [], "a call no context owns");
  const own = (calls: readonly RecordedCall[]) =>
    calls.filter((made) => made.by === OPERATION).map((made) => made.name);
  assert.deepEqual(unhandled, [], "a rejection went unhandled");
  const result = { outcome, at: browserAt, log, publishedAtMark, changesAtMark };
  if (at === null) {
    // Unheld, the operation makes exactly the calls of its trace.
    assert.deepEqual(own(since), variant.trace, `${name}: the trace`);
    return result;
  }
  // Up to the held call, each call of the trace was admitted before the move.
  assert.deepEqual(
    own(recorded.calls.slice(callsAtStart, callsAtMark)),
    variant.trace.slice(0, at.index + 1),
    "the calls admitted before the move",
  );
  // The held call, admitted before the move, completes as its store makes it.
  const heldCall = recorded.calls
    .slice(callsAtStart, callsAtMark)
    .filter((made) => made.by === OPERATION)[at.index]!;
  assert.notEqual(heldCall.settled, null, `the admitted ${at.name} did not complete`);
  // The move writes only what it makes itself: nothing, or its started session's keep, or the debug room it opens.
  if (move !== null) {
    const allowed = new Set<string>(
      (startsAnew ? MOVE_WRITES[move].starting : MOVE_WRITES[move].still).flatMap(
        (name: string): readonly string[] =>
          name === "kept" || name === "rooms" ? KEEP_WRITES[name] : [name],
      ),
    );
    assert.deepEqual(
      recorded.calls
        .slice(callsAtStart)
        .filter((made) => made.by === MOVE && made.write && !allowed.has(made.name))
        .map((made) => made.name),
      [],
      "the move wrote what it does not make itself",
    );
    // And each of its kept-store writes is one of the keeps of the session it started, by the host's own captures.
    assert.deepEqual(unledgered(since), [], "the move's kept-store writes are not its keeps");
  }
  // Another script's writes are no call of this page's operation: they finish after the move (`OTHER_SCRIPT_WRITES`).
  const ofThisPage = (made: RecordedCall) =>
    made.scope === undefined || !Object.hasOwn(OTHER_SCRIPT_WRITES, made.scope);
  const late = own(recorded.calls.slice(callsAtMark).filter(ofThisPage));
  if (!retires) {
    // Current, the operation goes on with the rest of its trace.
    assert.deepEqual(late, variant.trace.slice(at.index + 1), "the current operation's calls");
    return result;
  }
  // Stale: no call is admitted after the move. The held call completes; a restored session is released.
  assert.deepEqual(
    late.filter((made) => made !== "host.release"),
    [],
    `the stale ${producer} made calls after the move`,
  );
  // No page effect after the move but releasing its own importing mark, which shows what the mark held back.
  for (const change of log.changes.slice(changesAtMark).filter((made) => made.by === OPERATION)) {
    const { importing: markFrom, activation: _from, ...restFrom } = change.from;
    const { importing: markTo, activation: _to, ...restTo } = change.to;
    assert.ok(
      markFrom && !markTo && JSON.stringify(restFrom) === JSON.stringify(restTo),
      `the stale ${producer} changed the page: ${JSON.stringify(change)}`,
    );
  }
  // The page stays as the move left it, where the move did not wait for the operation.
  if (!moveWaits)
    assert.deepEqual(
      after,
      {
        ...before,
        importing: false,
        activation: before.importing ? after.activation : before.activation,
      },
      `the page after the stale ${producer}`,
    );
  // Where the room change waited for the operation, the page ends in the debug room as the change leaves it, once both
  // settled: its saved values, and its Start or Continue.
  if (moveWaits) {
    assert.equal(after.room, "debug");
    assert.equal(after.importing, false);
    assert.deepEqual(
      after.savedValues,
      await browserAt.rooms.values(SCOPE).load(),
      "the page shows the debug room's saved values",
    );
    assert.equal(after.activation, after.debugSession ? "continue" : "start");
  }
  // Its failure is neither shown nor thrown.
  assert.equal(outcome.rejected, false, `the stale ${producer} rejected`);
  const introduced = recorded.introduced();
  if (introduced !== null && move !== "disposed")
    assert.equal(bridge.store(introduced), null, "the stale restore's session was released");
  return result;
}

/** The saved-data import `name`'s declared scripts, or `null` for another variant. */
const savedDataScripts = (name: VariantName) =>
  Object.entries(SAVED_DATA_SCRIPTS).find(([variant]) => variant === name)?.[1] ?? null;

/**
 * The saved data of a script as `bundleOf` imports it, complete: its score, and its photo under the reference the import
 * stored it with, which must name a record in that script's media store (`media`, under its namespace) holding
 * `bundleOf`'s bytes; or none at all for a script the import did not write, as the page and the other script start with
 * none (#1963 L5).
 */
async function assertImported(
  entries: readonly { readonly key: string; readonly value: unknown }[],
  written: boolean,
  media: { readonly repository: FakeMediaRepository; readonly namespace: string },
  what: string,
) {
  // The fixture's provider adds its own read counter to each load (`familyBrowser`): no saved value of the script.
  const values = entries.filter((entry) => entry.key !== "read");
  if (!written) return assert.deepEqual(values, [], what);
  const sorted = [...values].sort((one, other) => (one.key < other.key ? -1 : 1));
  const photo = sorted[0]?.value;
  assert.ok(
    typeof photo === "string" && isWellFormedCapturedMediaReference(photo),
    `${what}: its photo's reference`,
  );
  const record = await media.repository.get(media.namespace, photo);
  assert.ok(record !== null, `${what}: its photo is stored under ${photo}`);
  assert.ok(record.data instanceof Blob, `${what}: its photo's bytes`);
  assert.deepEqual(
    new Uint8Array(await record.data.arrayBuffer()),
    PNG,
    `${what}: the stored photo is the imported one`,
  );
  assert.deepEqual(
    sorted,
    [
      { key: "photo", value: photo },
      { key: "score", value: 3 },
    ],
    what,
  );
}

/**
 * Whether the scripts a saved-data import wrote are those `SAVED_DATA_SCRIPTS` declares, each complete: another script's,
 * written also after the page moved on, and, when the import ran to its end (`ranToEnd`), the shown one's.
 */
async function assertWrites(name: VariantName, at: FamilyBrowser, ranToEnd: boolean) {
  const scripts = savedDataScripts(name);
  if (scripts === null) return;
  const writes: readonly ImportedScript[] = scripts.writes;
  await assertImported(
    await at.otherValues(OTHER_SCOPE),
    writes.includes("other"),
    { repository: at.otherRepository, namespace: OTHER_SCOPE },
    "the other script's saved data",
  );
  if (!ranToEnd) return;
  await assertImported(
    await at.rawProvider.load(),
    writes.includes("shown"),
    { repository: at.rawRepository, namespace: SCOPE },
    "the shown script's saved data",
  );
}

// EVIDENCE: invariant: the keys of `VARIANTS`, declared literally in the descriptor.
for (const name of Object.keys(VARIANTS) as VariantName[]) {
  const variant: Variant = VARIANTS[name];
  test(`continuation ownership: ${name}, unheld`, async (context) => {
    const { outcome, log, at } = await ownershipRun(context, name, null, null);
    await assertWrites(name, at, true);
    const failure = CURRENT_FAILURES[name];
    if (failure === undefined) {
      assert.equal(outcome.rejected, false, `${name} rejected`);
      return;
    }
    // A current failure surfaces, and the page offers what is left.
    assert.equal(outcome.rejected, true, `${name} did not reject`);
    assert.match(String(outcome.rejected && outcome.error), failure.message);
    assert.equal(log.snapshot().activation, failure.offers);
  });
  for (const point of holdable(variant.trace))
    for (const move of MOVES) {
      const retires = stale(variant.producer, move, variant.route, variant.ownership);
      if (retires === "unreachable") continue;
      test(`continuation ownership: ${name} at ${point.name}#${point.skip + 1}, ${move}`, async (context) => {
        const row = await ownershipRun(context, name, point, move);
        // Another script's saved data, which the player confirmed, are written also after this page moved on, while the
        // page shows nothing of the import (`ownershipRun`'s checks); a current import writes the shown one's too.
        await assertWrites(name, row.at, retires !== true);
        if (retires || variant.producer === "savedDataImport") return;
        // A keep the move left current goes on: it saves, or after a state it cannot write, says so.
        if (name === "captureKeep captured forget")
          assert.ok(
            row.log.changes
              .slice(row.changesAtMark)
              .some((change) => change.to.notices.includes("session-not-kept")),
            "the current keep did not say that the session is not kept",
          );
        else if (variant.route === "debug")
          assert.ok((await row.at.rooms.session(SCOPE)) !== null, "the current keep did not save");
        else
          assert.ok(row.at.published.length > row.publishedAtMark, "the current keep did not save");
      });
    }
}

// The checks' own controls, on one row (a stale restore, its page moved to another plan, whose Start runs and keeps
// itself). Once the run settled, each control writes the moved-on page's kept session in a context, with nothing else:
// its setup reads the store as it is, past the recorder. Each must fail the row for its own reason; the same control
// without its write passes.
const CONTROL_POINT = { index: 3, name: "kept.media.get", skip: 0 };
const control = (context: TestContext, write?: (at: FamilyBrowser) => Promise<void>) =>
  ownershipRun(
    context,
    "restoreKept captured sessionPhoto",
    CONTROL_POINT,
    "otherPlan",
    async (at) => {
      assert.ok((await at.rawKept.session(SCOPE)) !== null, "the moved-on session is kept");
      await write?.(at);
    },
  );
const failsFor = (pattern: RegExp) => (error: unknown) =>
  error instanceof assert.AssertionError && pattern.test(error.message);
test("continuation ownership's checks: a control without its write passes", async (context) => {
  await control(context);
});
for (const [label, reason] of [
  [MOVE, /the move's kept-store writes are not its keeps/],
  ["foreign", /a call no context owns/],
  [OPERATION, /made calls after the move/],
  [undefined, /a call no context owns/],
] as const)
  test(`continuation ownership's checks catch a stray discard in context ${label ?? "none"}`, async (context) => {
    await assert.rejects(
      control(context, (at) =>
        label === undefined
          ? at.kept.discard(SCOPE)
          : contexts.run(label, () => at.kept.discard(SCOPE)),
      ),
      failsFor(reason),
    );
  });
/** The page's first kept state, an earlier one than the moved-on session's, published in the move's context. */
async function republish(at: FamilyBrowser, scope: string, from: "later" | "first") {
  const earlier = at.published[0]!;
  const count = (await at.rawKept.session(SCOPE))?.events.length ?? 0;
  await contexts.run(MOVE, async () => {
    if (from === "first") await at.kept.discard(scope);
    await at.kept.publish(
      scope,
      from === "first"
        ? earlier
        : { ...earlier, planJson: null, eventsFrom: count, events: [], eventsJson: [] },
    );
  });
}
for (const [what, scope, from] of [
  ["a later save of an earlier state", SCOPE, "later"],
  ["a whole keep of an earlier state", SCOPE, "first"],
  ["a whole keep in another scope", "development-package:other", "first"],
] as const)
  test(`continuation ownership's checks catch ${what} in the move's context`, async (context) => {
    await assert.rejects(
      control(context, (at) => republish(at, scope, from)),
      failsFor(/the move's kept-store writes are not its keeps/),
    );
  });
test("continuation ownership's checks: a call of an unknown context is no one's", () => {
  const made: RecordedCall = {
    name: "kept.discard",
    destination: "kept",
    by: "foreign",
    write: true,
    settled: "resolved",
  };
  assert.deepEqual(unowned([made]), ["foreign:kept.discard"]);
});

// An import queued behind saved-values work issued before it, and retired while it waits: when the queue reaches it,
// none of its calls is admitted.
for (const move of MOVES)
  test(`continuation ownership: planText captured savedPhoto queued, ${move}`, async (context) => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    context.after(() => process.off("unhandledRejection", onUnhandled));
    const shown = stubBrowser(context);
    planWrites(context, SAVED_PHOTO_PLAN, ASKS_OTHER);
    const at = familyBrowser();
    const recorded = recorder(context, at);
    const operation = await VARIANT_DRIVERS["planText captured savedPhoto"](context, at, {
      watchHost: recorded.watchHost,
      hide: shown.hide,
      failHost: recorded.failHost,
    });
    // The page's own read of the saved values, issued first, holds the queue.
    const reached = recorded.hold("provider.load", 0, null);
    const reading = operation.host.readSavedData().catch(() => []);
    await reachedWithin(reached, "the page's own read", recorded.calls);
    const done = contexts.run(OPERATION, () => operation.start()).catch((error: unknown) => error);
    for (let turn = 0; turn < 4; turn++) await tasks();
    const queued = ["provider.replace", "repository.add", "repository.get"];
    const ownQueued = (from: number) =>
      recorded.calls
        .slice(from)
        .filter((made) => made.by === OPERATION && queued.includes(made.name))
        .map((made) => made.name);
    // It waits behind the read: one issue order for the page and its operations.
    assert.deepEqual(ownQueued(0), [], "the import did not wait for the work issued before it");
    const mark = recorded.calls.length;
    await contexts.run(MOVE, () => moveOn(operation, move));
    recorded.release();
    await reading;
    assert.equal(await done, undefined, "the stale import rejected");
    for (let turn = 0; turn < 6; turn++) await tasks();
    assert.deepEqual(ownQueued(mark), [], "the queued import's calls were admitted after the move");
    assert.deepEqual(unhandled, []);
  });

/** A reservation whose task has not run, while its page moves on. */
for (const move of MOVES)
  test(`continuation ownership: preparePlanText at task, ${move}`, async (context) => {
    stubBrowser(context);
    const at = browser();
    planWrites(context, ASKS, ASKS_OTHER);
    const { host, scope } = await mount(context, at);
    const token = await held(host, ASKS);
    const preparing = host.prepareScript(token, {
      plan: token,
      options: () => ({ ...host.scriptStorageOptions(), ...host.temporalCapture() }),
    });
    // The page reserves once its host is ready; the move comes before the reservation's task.
    await host.bridge;
    await held(host, ASKS);
    await moveOn({ host, scope, plan: ASKS, start: async () => {} }, move);
    await preparing;
    for (let turn = 0; turn < 4; turn++) await tasks();
    // Let go of where the move retired the plan, kept where it did not.
    const bridge = await host.bridge;
    const before = await writesOn(host, ASKS);
    await bridge.client.request("planText", { plan: token });
    assert.equal((await writesOn(host, ASKS)) - before, stale("preparePlanText", move) ? 1 : 0);
  });

test("continuation ownership covers its descriptor: each route driven or named, each variant held at each call", (context) => {
  for (const unheld of Object.keys(UNHELD_AWAITS))
    assert.ok(!Object.hasOwn(POSTED, unheld), `${unheld} is both posted and named unheld`);
  assert.deepEqual(Object.keys(VARIANT_DRIVERS).sort(), Object.keys(VARIANTS).sort());
  const variants: Variant[] = Object.values(VARIANTS);
  const named = new Set<string>();
  for (const producer of OPERATED)
    for (const ownership of OWNERSHIP_MODES[producer])
      for (const route of ROUTES) {
        const path = `${producer} ${route} ${ownership}`;
        named.add(path);
        const driven = variants.some(
          (v) => v.producer === producer && v.route === route && v.ownership === ownership,
        );
        assert.equal(driven, !Object.hasOwn(UNDRIVEN_ROUTES, path), path);
      }
  for (const variant of variants)
    assert.ok(
      OWNERSHIP_MODES[variant.producer].some((mode) => mode === variant.ownership),
      `${variant.producer} takes no ${variant.ownership} ownership`,
    );
  for (const path of Object.keys(UNDRIVEN_ROUTES)) assert.ok(named.has(path), `${path} is a path`);
  // Every producer's caller is an operation, or named as none.
  for (const producer of Object.keys(PRODUCERS))
    assert.equal(
      OPERATED.some((operated) => operated === producer),
      !Object.hasOwn(UNOPERATED, producer),
      producer,
    );
  // Every surface is a store the recorder installs or one a store method gives, and each such store is a surface.
  const within = Object.entries(SURFACES).flatMap(([surface, methods]) =>
    Object.entries(methods)
      .filter(([, kind]) => kind === "store")
      .map(([method]) => `${surface}.${method}`),
  );
  assert.deepEqual(Object.keys(SURFACES).sort(), [...RECORDED_STORES, ...within].sort());
  // Each saved-data import declares its scripts, and writes only scripts it imports.
  // EVIDENCE: invariant: the keys of `VARIANTS`, declared literally in the descriptor.
  for (const name of Object.keys(VARIANTS) as VariantName[])
    assert.equal(
      savedDataScripts(name) !== null,
      VARIANTS[name].producer === "savedDataImport",
      name,
    );
  for (const [name, { imports, writes }] of Object.entries(SAVED_DATA_SCRIPTS))
    for (const script of writes)
      assert.ok(
        imports.some((imported) => imported === script),
        `${name} writes ${script}`,
      );
  // No surface classifies a method it does not name: an unknown name, or one every object inherits.
  for (const surface of Object.keys(SURFACES))
    for (const key of [
      "unknownMethod",
      "toString",
      "constructor",
      "hasOwnProperty",
      "valueOf",
      "__proto__",
    ])
      assert.equal(methodClass(surface, key), undefined, `${surface}.${key}`);
  let held = 0;
  for (const variant of variants) {
    assert.ok(holdable(variant.trace).length > 0, `a variant of ${variant.producer} holds nothing`);
    held += holdable(variant.trace).length;
  }
  context.diagnostic(`${variants.length} variants, ${held} held calls`);
});
