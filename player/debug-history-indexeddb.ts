import { randomUuid } from "./captured-media.js";
import type { DebugHistorySpill } from "./debug-history.js";

/**
 * Debug's rewind history spills snapshots to a database of its own, named by this prefix and a random UUID, which its
 * history deletes when Debug is turned off, the session is replaced, or the Player unmounts. A page that crashed leaves
 * its database behind; the next Player removes it (`sweepDebugHistories`).
 */
const NAME_PREFIX = "teasescript-debug-history-";
const NAME_PATTERN =
  /^teasescript-debug-history-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const STORE = "snapshots";

// The databases this page opened, which its own sweep never deletes.
const opened = new Set<string>();

function settled<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

function committed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    // A request's error reaches the transaction before the transaction has an error of its own, so it is the cause.
    transaction.onerror = (event) =>
      reject(
        (event.target instanceof IDBRequest ? event.target.error : null) ??
          new Error("IndexedDB transaction failed."),
      );
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed."));
  });
}

// Resolves once the deletion is done or waits for another page that holds the database open; that page deletes it
// itself, and the waiting request removes nothing it still uses.
function deleteDatabase(factory: IDBFactory, name: string): Promise<void> {
  return new Promise((resolve) => {
    const request = factory.deleteDatabase(name);
    request.onsuccess = request.onerror = request.onblocked = () => resolve();
  });
}

/** A new spill store for one history, or `null` where IndexedDB cannot be used. */
export async function openDebugHistorySpill(
  factory: IDBFactory | undefined = globalThis.indexedDB,
): Promise<DebugHistorySpill | null> {
  if (factory === undefined) return null;
  const name = `${NAME_PREFIX}${randomUuid()}`;
  opened.add(name);
  const request = factory.open(name, 1);
  request.onupgradeneeded = () => request.result.createObjectStore(STORE);
  let database: IDBDatabase;
  try {
    database = await settled(request);
  } catch {
    opened.delete(name);
    await deleteDatabase(factory, name);
    return null;
  }
  // There is no `versionchange` handler: when another page's sweep asks to delete this database, it stays open, so that
  // deletion waits until this history ends.
  let closed = false;
  const transaction = (mode: IDBTransactionMode) => {
    if (closed) throw new Error("The history's spill store is closed.");
    return database.transaction(STORE, mode);
  };
  return {
    async put(id, json) {
      const write = transaction("readwrite");
      write.objectStore(STORE).put(json, id);
      await committed(write);
    },
    async get(id) {
      const read = transaction("readonly");
      const value: unknown = await settled(read.objectStore(STORE).get(id));
      return typeof value === "string" ? value : undefined;
    },
    async delete(ids) {
      const write = transaction("readwrite");
      const store = write.objectStore(STORE);
      for (const id of ids) store.delete(id);
      await committed(write);
    },
    async destroy() {
      if (closed) return;
      closed = true;
      database.close();
      await deleteDatabase(factory, name);
      opened.delete(name);
    },
  };
}

/**
 * Deletes the history databases that pages which ended without deleting theirs left behind. A database another open
 * Player still uses is deleted only once that Player closes it, which it does when its history ends. Browsers without
 * `indexedDB.databases()` keep such leftovers.
 */
export async function sweepDebugHistories(
  factory: IDBFactory | undefined = globalThis.indexedDB,
): Promise<void> {
  if (typeof factory?.databases !== "function") return;
  let databases: readonly IDBDatabaseInfo[];
  try {
    databases = await factory.databases();
  } catch {
    return;
  }
  for (const { name } of databases)
    if (name !== undefined && NAME_PATTERN.test(name) && !opened.has(name))
      void deleteDatabase(factory, name);
}
