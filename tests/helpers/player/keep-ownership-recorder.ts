/*
 * Continuation ownership's recorder (`tests/player/player-keep-ownership.test.ts`): the family's browser, its stores
 * behind one recorder of every call with the async context that made it, and the two judgements of a run's calls,
 * `unowned` and `unledgered`.
 */

import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { type TestContext } from "node:test";
import { effectScope, watch } from "vue";
import {
  memoryKeptRoomStore,
  type KeptRoomStore,
  type KeptSessionStore,
} from "../../../player/persistence/kept-sessions.js";
import {
  createLocalScriptStorage,
  type ScriptStorageProvider,
} from "../../../player/persistence/script-storage.js";
import { LIFECYCLE, SURFACES } from "./plan-json-family.js";
import { type CapturedMediaRecord } from "../../../player/media/captured-media.js";
import type { PlayerBridge } from "../../../player/runtime/player-bridge.js";
import { FakeMediaRepository } from "./fake-media-repository.js";
import { KeepHost, browserSavedData, SCOPE, browser } from "./keep-host.js";

export const OPERATION = "operation";
export const MOVE = "move";
export const contexts = new AsyncLocalStorage<string>();

/**
 * A call of a recorded store or of the host: its admission, as the store received it, with the store it went to and
 * the async context that made it, fixed then; and its settlement, recorded apart once the store's promise settles.
 */
export interface RecordedCall {
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
export function unowned(calls: readonly RecordedCall[]): string[] {
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
export function unledgered(calls: readonly RecordedCall[]): string[] {
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
export function methodClass(surface: string, key: string): string | undefined {
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
export function recorder(context: TestContext, at: FamilyBrowser) {
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
export function familyBrowser(route: "plain" | "captured" = "captured") {
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
export type FamilyBrowser = ReturnType<typeof familyBrowser>;

/** The page as its player sees it, and each change of it with the async context that made it. */
export function pageLog(host: KeepHost) {
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
