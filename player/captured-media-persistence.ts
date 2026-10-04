import type { SerializableRuntimeValue } from "../src/index.js";
import { isCapturedMediaReference, type CapturedMediaStore } from "./captured-media.js";
import type { ScriptStorageProvider } from "./script-storage.js";

/**
 * Captured-media references inside a stored value: list and set items, object property names and values. A match is
 * only a candidate: an unknown or forged reference stays ordinary data.
 */
export function capturedMediaReferences(value: SerializableRuntimeValue): Set<string> {
  const found = new Set<string>();
  const pending: SerializableRuntimeValue[] = [value];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    if (typeof current === "string") {
      if (isCapturedMediaReference(current)) found.add(current);
    } else if (current !== null && typeof current === "object") {
      // Item by item: a wide stored value must not hit the native argument limit of a spread.
      if (current.kind === "list" || current.kind === "set")
        for (const item of current.items) pending.push(item);
      else if (current.kind === "object")
        for (const property of current.properties) pending.push(property.name, property.value);
    }
  }
  return found;
}

/** A script-storage provider that keeps saved captured media durable; `drain` waits for issued work and stops it. */
export interface CapturedMediaStorage extends ScriptStorageProvider {
  /** Rejects later operations and resolves once every issued operation finished. */
  drain(): Promise<void>;
}

/**
 * Wraps the script-storage provider so saved captured media stays resolvable in later runs: every write first stores
 * the session media it references durably, then persists the value. When the media cannot be stored, the write is not
 * persisted at all, so no saved reference outlives its media: the write rejects with `CapturedMediaNotStoredError`, and
 * the host acknowledges the runtime's `storageWrite` as failed, which keeps the previous value. All operations run in issue order, so a clear cannot be refilled by an
 * earlier write of the same Player. Nothing is deleted here; unreferenced media is removed by `sweepCapturedMedia`.
 */
export function withCapturedMedia(
  provider: ScriptStorageProvider,
  media: CapturedMediaStore,
): CapturedMediaStorage {
  let queue: Promise<unknown> = Promise.resolve();
  let draining = false;
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    if (draining) return Promise.reject(new Error("Script storage is closed."));
    const next = queue.then(operation, operation);
    queue = next.catch(() => {});
    return next;
  };
  return {
    scope: provider.scope,
    load: () => enqueue(() => provider.load()),
    write: (key, value) =>
      enqueue(async () => {
        await media.promote(capturedMediaReferences(value));
        await provider.write(key, value);
      }),
    clear: () => enqueue(() => provider.clear()),
    async drain() {
      draining = true;
      await queue;
    },
  };
}

/** Whether a Player holds the shared live lock; only `unsupported` and `held` permit durable media writes. */
export type LiveMediaLease = "held" | "unsupported" | "failed";

/** Coordination of captured media across every Player of one scope, also in other tabs. */
export interface CapturedMediaLocks {
  /**
   * Requests the shared live-Player lock; `granted` settles once it is held, or with why it is not. `release` frees it,
   * also while the request is still pending.
   */
  holdLive(scope: string): { readonly granted: Promise<LiveMediaLease>; release(): void };
  /**
   * Runs `work` with the exclusive lock if no Player of the scope is live anywhere; returns `false` without running
   * it otherwise, or when locks are unavailable.
   */
  whenIdle(scope: string, work: () => Promise<void>): Promise<boolean>;
}

const lockName = (scope: string) => `teasescript-captured-media:${scope}`;

/** Web Locks coordination; without it no Player can prove it is alone, so media is never swept. */
export function browserCapturedMediaLocks(): CapturedMediaLocks {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  return {
    holdLive(scope) {
      if (locks === undefined)
        return { granted: Promise.resolve("unsupported" as const), release: () => {} };
      const abort = new AbortController();
      let release = () => abort.abort();
      const granted = new Promise<LiveMediaLease>((resolve) => {
        locks
          .request(lockName(scope), { mode: "shared", signal: abort.signal }, () => {
            resolve("held");
            return new Promise<void>((done) => (release = done));
          })
          .catch(() => resolve("failed"));
      });
      return { granted, release: () => release() };
    },
    async whenIdle(scope, work) {
      if (locks === undefined) return false;
      return locks.request(
        lockName(scope),
        { mode: "exclusive", ifAvailable: true },
        async (lock) => {
          if (lock === null) return false;
          await work();
          return true;
        },
      );
    },
  };
}
/**
 * Removes stored media of the scope that no saved value references any more. It runs only while no Player of the
 * scope is live, against a fresh read of the saved values; when either cannot be established it defers.
 */
export async function sweepCapturedMedia(
  provider: ScriptStorageProvider,
  media: CapturedMediaStore,
  locks: CapturedMediaLocks,
): Promise<boolean> {
  return locks.whenIdle(provider.scope, async () => {
    const referenced = new Set<string>();
    for (const entry of await provider.load())
      for (const reference of capturedMediaReferences(entry.value)) referenced.add(reference);
    await media.sweep(referenced);
  });
}

/** Captured-media persistence for one mounted Player; the host passes it to the session as its script storage. */
export interface CapturedMediaPersistence extends CapturedMediaStorage {
  /** Finishes issued storage work, then releases the live lock; call when the Player unmounts. */
  close(): Promise<void>;
}

/**
 * Prepares captured-media persistence for a mounted Player in the only safe order: an opportunistic sweep while no
 * Player of the scope is live, then the shared live lock. Every `load()` and `write()` waits for that preparation, so a
 * Start reads its saved values fresh, and only under the live lock. Without the lock where locks exist, durable media
 * writes are disabled so they can never race another Player's sweep.
 */
export function capturedMediaStorage(
  provider: ScriptStorageProvider,
  media: CapturedMediaStore,
  locks: CapturedMediaLocks,
): CapturedMediaPersistence {
  let release = () => {};
  const ready = (async () => {
    // A failed sweep only defers reclamation.
    await sweepCapturedMedia(provider, media, locks).catch(() => false);
    const live = locks.holdLive(provider.scope);
    release = () => live.release();
    if ((await live.granted) === "failed") media.disableDurable();
  })();
  const storage = withCapturedMedia(provider, media);
  return {
    scope: provider.scope,
    load: async () => (await ready, storage.load()),
    write: async (key, value) => (await ready, storage.write(key, value)),
    clear: async () => (await ready, storage.clear()),
    drain: () => storage.drain(),
    async close() {
      await ready;
      await storage.drain();
      release();
    },
  };
}
