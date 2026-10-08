import type { InterpreterEvent } from "../src/index.js";
import type { CapturedMediaRecord, CapturedMediaRepository } from "./captured-media.js";
import { parseEditedWhileDebugging, parseRewoundWhileDebugging } from "./debug-export.js";
import type { DebugHistoryMarks } from "./debug-history.js";

/**
 * Where the Player keeps each script's session (PLAYER-UI "Session start and user activation"), by storage scope, so that
 * a reload or a later visit in this browser continues it: its plan, its snapshot, the events that led to it, its marks,
 * and the photos only it uses, which no save stored. A scope keeps at most one session.
 */
export interface KeptSessionStore {
  /** The scope's session as stored, not yet validated, or `null`. */
  session(scope: string): Promise<StoredKeptSession | null>;
  /**
   * Stores the scope's session at once. The stored events before `eventsFrom` stay, the rest are replaced by `events`;
   * `planJson` is `null` to keep the stored plan. Rejects without a plan, or with a gap in the events.
   */
  publish(scope: string, session: KeptSessionUpdate): Promise<void>;
  /** The photos of every kept session, with the scope as namespace. */
  readonly media: CapturedMediaRepository;
  /** Deletes the scope's session and its photos, at once. */
  discard(scope: string): Promise<void>;
}

/** The state a reload continues: the plan the session runs, its snapshot, the events that led to it, and its marks. */
export interface KeptSession {
  readonly planJson: string;
  readonly snapshotJson: string;
  readonly events: readonly InterpreterEvent[];
  readonly marks: DebugHistoryMarks;
}

/** A session read back from storage: external data until `keptSession` validated it. */
export interface StoredKeptSession {
  readonly planJson: unknown;
  readonly snapshotJson: unknown;
  readonly events: readonly unknown[];
  readonly marks: unknown;
}

export interface KeptSessionUpdate {
  readonly planJson: string | null;
  readonly snapshotJson: string;
  readonly eventsFrom: number;
  readonly events: readonly InterpreterEvent[];
  readonly marks: DebugHistoryMarks;
}

const EVENT_KINDS: ReadonlySet<unknown> = new Set<InterpreterEvent["kind"]>([
  "say",
  "messageUpdated",
  "exit",
  "actionRequested",
  "actionCompleted",
  "playerTranscript",
  "permanentButtonPressed",
  "developerWarning",
  "runtimeFailure",
  "scriptStorageEdited",
]);

/**
 * The stored session when its fields have their types and its events are records of known kinds in increasing
 * sequence, else `null`. Restoring validates the snapshot against the plan; the events are this Player's own record of
 * the same session, so their contents are not checked further here.
 */
export function keptSession(stored: StoredKeptSession): KeptSession | null {
  const { planJson, snapshotJson, events, marks } = stored;
  if (typeof planJson !== "string" || typeof snapshotJson !== "string") return null;
  let sequence = 0;
  for (const event of events) {
    if (!isRecord(event)) return null;
    const next = event["sequence"];
    if (!EVENT_KINDS.has(event["kind"]) || typeof next !== "number" || !Number.isSafeInteger(next))
      return null;
    if (next <= sequence) return null;
    sequence = next;
  }
  if (!isRecord(marks)) return null;
  try {
    return {
      planJson,
      snapshotJson,
      // EVIDENCE: validation: the loop above proved each event a record of a known kind in increasing sequence.
      events: events as readonly InterpreterEvent[],
      marks: {
        editedWhileDebugging: parseEditedWhileDebugging(marks["editedWhileDebugging"] ?? null),
        rewoundWhileDebugging: parseRewoundWhileDebugging(marks["rewoundWhileDebugging"] ?? null),
      },
    };
  } catch {
    return null;
  }
}

// A reference as `CapturedMediaStore` hands it out (`captured-media.ts`), anywhere in JSON text.
const REFERENCES_IN_TEXT =
  /captured-media:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[1-9][0-9]{0,15}/gu;

/** The captured-media references in serialized state, such as photos a session shows or holds in variables. */
export function capturedMediaReferencesInJson(json: string): Set<string> {
  return new Set(json.match(REFERENCES_IN_TEXT));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const noPlan = () => new Error("The kept session has no plan.");
const eventGap = () => new RangeError("The kept session's events have a gap.");

/** A store in this page's memory, for a browser without IndexedDB; a reload ends its sessions. */
export function memoryKeptSessionStore(): KeptSessionStore {
  interface Kept {
    session: { planJson: string; snapshotJson: string; marks: DebugHistoryMarks } | null;
    events: InterpreterEvent[];
    readonly media: Map<string, CapturedMediaRecord>;
  }
  const kept = new Map<string, Kept>();
  const scopeOf = (scope: string): Kept => {
    let found = kept.get(scope);
    if (found === undefined)
      kept.set(scope, (found = { session: null, events: [], media: new Map() }));
    return found;
  };
  return {
    session: async (scope) => {
      const found = kept.get(scope);
      return found?.session ? { ...found.session, events: [...found.events] } : null;
    },
    async publish(scope, update) {
      const found = scopeOf(scope);
      const planJson = update.planJson ?? found.session?.planJson;
      if (planJson === undefined) throw noPlan();
      if (update.eventsFrom > found.events.length) throw eventGap();
      found.events = [...found.events.slice(0, update.eventsFrom), ...update.events];
      found.session = { planJson, snapshotJson: update.snapshotJson, marks: update.marks };
    },
    media: {
      get: async (namespace, reference) => kept.get(namespace)?.media.get(reference) ?? null,
      async add(record) {
        const photos = scopeOf(record.namespace).media;
        if (photos.has(record.reference))
          throw new DOMException("The photo is stored already.", "ConstraintError");
        photos.set(record.reference, record);
      },
      delete: async (namespace, reference) => void kept.get(namespace)?.media.delete(reference),
      listReferences: async (namespace) => [...(kept.get(namespace)?.media.keys() ?? [])],
    },
    discard: async (scope) => void kept.delete(scope),
  };
}

const DATABASE_VERSION = 1;
const SESSIONS = "sessions";
const EVENTS = "events";
const MEDIA = "media";

/**
 * Opens the kept sessions of this browser in IndexedDB (`teasescript-kept-sessions`): sessions, events by scope and
 * position, and photos by scope and reference. Each operation is one transaction. Rejects when IndexedDB is unavailable
 * or refused.
 */
export function openIndexedDbKeptSessionStore(
  name = "teasescript-kept-sessions",
): Promise<KeptSessionStore> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new DOMException("IndexedDB is unavailable.", "NotSupportedError"));
      return;
    }
    const request = indexedDB.open(name, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      database.createObjectStore(SESSIONS, { keyPath: "scope" });
      database.createObjectStore(EVENTS);
      database.createObjectStore(MEDIA, { keyPath: ["namespace", "reference"] });
    };
    request.onblocked = () =>
      reject(new DOMException("Kept session storage is blocked.", "InvalidStateError"));
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      // Another tab upgrading the database needs this connection closed.
      database.onversionchange = () => database.close();
      resolve(indexedDbStore(database));
    };
  });
}

// Every key [scope, …] sorts between [scope] and [scope, []]: arrays sort after numbers and strings.
const scopeRange = (scope: string) => IDBKeyRange.bound([scope], [scope, []]);
const eventsFrom = (scope: string, from: number) =>
  IDBKeyRange.bound([scope, from], [scope, Infinity]);

function indexedDbStore(database: IDBDatabase): KeptSessionStore {
  /**
   * Runs `work` in one transaction over `stores` and resolves with its result once the transaction committed; `work`
   * receives a `fail` that aborts the transaction with an error, so nothing it wrote stays.
   */
  function transact<T>(
    stores: readonly string[],
    mode: IDBTransactionMode,
    work: (
      transaction: IDBTransaction,
      done: (result: T) => void,
      fail: (error: Error) => void,
    ) => void,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction([...stores], mode);
      let result: T;
      let failure: Error | null = null;
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = transaction.onerror = () =>
        reject(failure ?? transaction.error ?? new DOMException("Aborted.", "AbortError"));
      work(
        transaction,
        (value) => (result = value),
        (error) => {
          failure = error;
          transaction.abort();
        },
      );
    });
  }
  const got = <T>(request: IDBRequest<T>, then: (value: T) => void) => {
    request.onsuccess = () => then(request.result);
  };
  return {
    session: (scope) =>
      transact([SESSIONS, EVENTS], "readonly", (transaction, done) =>
        got(
          transaction.objectStore(SESSIONS).get(scope),
          (session: Record<string, unknown> | undefined) => {
            if (session === undefined) return done(null);
            got(transaction.objectStore(EVENTS).getAll(eventsFrom(scope, 0)), (events) =>
              done({
                planJson: session["planJson"],
                snapshotJson: session["snapshotJson"],
                marks: session["marks"],
                events,
              }),
            );
          },
        ),
      ),
    publish: (scope, update) =>
      transact<void>([SESSIONS, EVENTS], "readwrite", (transaction, _done, fail) => {
        const sessions = transaction.objectStore(SESSIONS);
        got(sessions.get(scope), (previous: Record<string, unknown> | undefined) => {
          const planJson = update.planJson ?? previous?.["planJson"];
          const eventCount = previous?.["eventCount"] ?? 0;
          if (typeof planJson !== "string") return fail(noPlan());
          if (typeof eventCount !== "number" || update.eventsFrom > eventCount)
            return fail(eventGap());
          const events = transaction.objectStore(EVENTS);
          events.delete(eventsFrom(scope, update.eventsFrom));
          update.events.forEach((event, index) =>
            events.put(event, [scope, update.eventsFrom + index]),
          );
          sessions.put({
            scope,
            planJson,
            snapshotJson: update.snapshotJson,
            marks: update.marks,
            eventCount: update.eventsFrom + update.events.length,
          });
        });
      }),
    media: {
      get: (namespace, reference) =>
        transact([MEDIA], "readonly", (transaction, done) =>
          got(transaction.objectStore(MEDIA).get([namespace, reference]), (record) =>
            done(record ?? null),
          ),
        ),
      // `add`, unlike `put`, fails instead of overwriting an existing record.
      add: (record) =>
        transact<void>([MEDIA], "readwrite", (transaction) => {
          transaction.objectStore(MEDIA).add(record);
        }),
      delete: (namespace, reference) =>
        transact<void>([MEDIA], "readwrite", (transaction) => {
          transaction.objectStore(MEDIA).delete([namespace, reference]);
        }),
      listReferences: (namespace) =>
        transact([MEDIA], "readonly", (transaction, done) =>
          got(transaction.objectStore(MEDIA).getAllKeys(scopeRange(namespace)), (keys) =>
            done(
              keys.flatMap((key) =>
                Array.isArray(key) && typeof key[1] === "string" ? [key[1]] : [],
              ),
            ),
          ),
        ),
    },
    discard: (scope) =>
      transact<void>([SESSIONS, EVENTS, MEDIA], "readwrite", (transaction) => {
        transaction.objectStore(SESSIONS).delete(scope);
        transaction.objectStore(EVENTS).delete(scopeRange(scope));
        transaction.objectStore(MEDIA).delete(scopeRange(scope));
      }),
  };
}
