import {
  storableCapturedMedia,
  type CapturedMediaRecord,
  type CapturedMediaRepository,
} from "./captured-media.js";

const DATABASE_VERSION = 1;
const STORE = "media";

/**
 * Opens browser-local durable storage for captured media. Rejects when IndexedDB is unavailable, blocked, or refused
 * (for example in some private modes); the Player then runs without durable captured media.
 */
export function openIndexedDbMediaRepository(
  name = "teasescript-captured-media",
): Promise<CapturedMediaRepository> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new DOMException("IndexedDB is unavailable.", "NotSupportedError"));
      return;
    }
    const request = indexedDB.open(name, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE, { keyPath: ["namespace", "reference"] });
    };
    request.onblocked = () =>
      reject(new DOMException("Captured media storage is blocked.", "InvalidStateError"));
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      // Another tab upgrading the database needs this connection closed.
      database.onversionchange = () => database.close();
      resolve(repository(database));
    };
  });
}

function repository(database: IDBDatabase): CapturedMediaRepository {
  return {
    get: (namespace, reference) =>
      new Promise((resolve, reject) => {
        const request = database
          .transaction(STORE, "readonly")
          .objectStore(STORE)
          .get([namespace, reference]);
        request.onsuccess = () => resolve(request.result ?? null);
        request.onerror = () => reject(request.error);
      }),
    add: async (record: CapturedMediaRecord) => {
      const stored = await storableCapturedMedia(record);
      // `add`, unlike `put`, fails instead of overwriting an existing record.
      return committed(database, (store) => store.add(stored));
    },
    delete: (namespace, reference) =>
      committed(database, (store) => store.delete([namespace, reference])),
    listReferences: (namespace) =>
      new Promise((resolve, reject) => {
        // Every key [namespace, reference] sorts between [namespace] and [namespace, []]: arrays sort after strings.
        const range = IDBKeyRange.bound([namespace], [namespace, []]);
        const request = database
          .transaction(STORE, "readonly")
          .objectStore(STORE)
          .getAllKeys(range);
        request.onsuccess = () =>
          resolve(
            request.result.flatMap((key) =>
              Array.isArray(key) && typeof key[1] === "string" ? [key[1]] : [],
            ),
          );
        request.onerror = () => reject(request.error);
      }),
  };
}

/** Resolves once the write transaction committed, not merely when its request succeeded. */
function committed(database: IDBDatabase, write: (store: IDBObjectStore) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE, "readwrite");
    transaction.oncomplete = () => resolve();
    // A request's error reaches the transaction before the transaction has an error of its own, so it is the cause.
    transaction.onerror = (event) =>
      reject(
        (event.target instanceof IDBRequest ? event.target.error : null) ??
          new DOMException("The write failed.", "UnknownError"),
      );
    transaction.onabort = () =>
      reject(transaction.error ?? new DOMException("The write was aborted.", "AbortError"));
    write(transaction.objectStore(STORE));
  });
}
