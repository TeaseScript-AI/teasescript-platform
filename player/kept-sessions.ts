import {
  isMessageMarkup,
  validateScriptStorageEntries,
  type InterpreterEvent,
  type RuntimeScriptStorageEntrySnapshot,
} from "../src/index.js";
import { isMessagePresentation } from "../src/message-presentation.js";
import { isFormUi, validFormResult } from "../src/runtime/actions/form.js";
import {
  storableCapturedMedia,
  type CapturedMediaRecord,
  type CapturedMediaRepository,
} from "./captured-media.js";
import type { MediaInUse } from "./captured-media-persistence.js";
import { parseEditedWhileDebugging, parseRewoundWhileDebugging } from "./debug-export.js";
import type { DebugHistoryMarks } from "./debug-history.js";
import type { ScriptStorageProvider } from "./script-storage.js";

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

/**
 * A kept session together with saved values of its own, by storage scope: the debug room of each script (DEBUGGER.md
 * "Debug room"), whose photos the store's `media` holds under the same references as the photos they were copied from.
 * A room is created and discarded as a whole.
 */
export interface KeptRoomStore extends KeptSessionStore {
  /** The scope's room, with whether it keeps a session, or `null` without one; rejects when the store cannot be read. */
  read(scope: string): Promise<{ readonly session: boolean } | null>;
  /**
   * Creates the scope's room with `entries` as its saved values and `photos` stored under their references; rejects
   * when the scope already has a room, or with an invalid entry, and then changes nothing.
   */
  create(
    scope: string,
    entries: readonly RuntimeScriptStorageEntrySnapshot[],
    photos: readonly CapturedMediaRecord[],
  ): Promise<void>;
  /** The room's saved values, as script storage; every operation rejects once the room is gone. */
  values(scope: string): ScriptStorageProvider;
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
 * sequence, each with the fields the Player reads from it, such as a message's markup, speaker, and presentation or an
 * answer's form, else `null`. Restoring validates the snapshot against the plan.
 */
export function keptSession(stored: StoredKeptSession): KeptSession | null {
  const { planJson, snapshotJson, events, marks } = stored;
  if (typeof planJson !== "string" || typeof snapshotJson !== "string") return null;
  let sequence = 0;
  for (const event of events) {
    if (!isRecord(event)) return null;
    const next = event["sequence"];
    if (!EVENT_KINDS.has(event["kind"]) || !isCount(next) || next <= sequence) return null;
    if (!validEvent(event)) return null;
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

/**
 * The photos the session a store keeps for a scope uses, which stay stored while it does; without a store, none. A
 * session that cannot be read rejects, so a sweep defers.
 */
export function keptPhotoReferences(store: KeptSessionStore | undefined): MediaInUse | undefined {
  return store && (async (scope) => capturedMediaReferencesIn(await store.session(scope)));
}

/**
 * The captured-media references in session data, such as photos a session shows or holds in variables: in its texts,
 * which may be serialized state, and in the texts of its records and lists, found one text at a time. A reference never
 * spans two texts, so this finds what a search of the data as one JSON text would, without building a text that long.
 */
export function capturedMediaReferencesIn(...data: readonly unknown[]): Set<string> {
  const found = new Set<string>();
  const pending = [...data];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    if (typeof current === "string") {
      for (const [reference] of current.matchAll(REFERENCES_IN_TEXT)) found.add(reference);
    } else if (Array.isArray(current)) {
      // Item by item: a long list of events must not hit the native argument limit of a spread.
      for (const item of current) pending.push(item);
    } else if (isRecord(current)) {
      for (const [key, value] of Object.entries(current)) pending.push(key, value);
    }
  }
  return found;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isText = (value: unknown): value is string => typeof value === "string";
const isTextOrNull = (value: unknown) => value === null || isText(value);
const isCountOrNull = (value: unknown) => value === null || isCount(value);
const isPosition = (value: unknown) =>
  isRecord(value) && isCount(value["offset"]) && isCount(value["line"]) && isCount(value["column"]);
const isSpan = (value: unknown) =>
  isRecord(value) && isPosition(value["start"]) && isPosition(value["end"]);
const isSpeaker = (value: unknown) =>
  value === null ||
  (isRecord(value) &&
    isText(value["identifier"]) &&
    isText(value["displayName"]) &&
    isTextOrNull(value["color"]) &&
    isTextOrNull(value["font"]) &&
    isTextOrNull(value["avatar"]));

/**
 * Whether a stored event of a known kind has the fields the Player reads from it: in the transcript, the history of
 * Debug's rewind, and a debug export.
 */
function validEvent(event: Record<string, unknown>): boolean {
  switch (event["kind"]) {
    case "say":
      return (
        isMessagePresentation(event["presentation"]) &&
        isSpeaker(event["speaker"]) &&
        isMessageMarkup(event["content"]) &&
        isText(event["text"]) &&
        isSpan(event["span"])
      );
    case "messageUpdated":
      return (
        isCount(event["messageId"]) &&
        isMessageMarkup(event["content"]) &&
        isText(event["text"]) &&
        isSpan(event["span"])
      );
    case "exit":
      return isSpan(event["span"]);
    case "actionRequested": {
      const action = event["action"];
      return (
        isRecord(action) &&
        isText(action["kind"]) &&
        isCount(action["actionId"]) &&
        isSpan(event["span"])
      );
    }
    case "actionCompleted":
      return validSettlement(event["settlement"]) && isSpan(event["span"]);
    case "playerTranscript":
      return (
        event["target"] === "standardChat" &&
        isCountOrNull(event["requestingSpeakerId"]) &&
        isText(event["text"]) &&
        isSpan(event["span"])
      );
    case "permanentButtonPressed":
      return isCount(event["buttonId"]) && isText(event["text"]) && isSpan(event["span"]);
    case "developerWarning":
      return (
        event["severity"] === "warning" &&
        isText(event["code"]) &&
        isText(event["message"]) &&
        isSpan(event["span"])
      );
    case "runtimeFailure":
      return (
        isText(event["code"]) &&
        isText(event["message"]) &&
        isText(event["path"]) &&
        isSpan(event["span"])
      );
    case "scriptStorageEdited":
      return (
        isText(event["key"]) &&
        (event["operation"] === "set" || event["operation"] === "delete") &&
        typeof event["currentSessionTimeMs"] === "number" &&
        typeof event["observedSessionTimeMs"] === "number"
      );
    default:
      return false;
  }
}

/**
 * A settlement's kind and identity, and an answer's sequence, text, and UI, with a form's answers and shown options
 * checked against it.
 */
function validSettlement(settlement: unknown): boolean {
  if (
    !isRecord(settlement) ||
    !isText(settlement["actionKind"]) ||
    !isCount(settlement["actionId"])
  )
    return false;
  if (settlement["actionKind"] !== "interaction") return true;
  const ui = settlement["ui"];
  const transcriptText = settlement["transcriptText"];
  if (
    !isText(settlement["interactionKind"]) ||
    !isCountOrNull(settlement["transcriptEventSequence"]) ||
    !isTextOrNull(transcriptText) ||
    !isRecord(ui)
  )
    return false;
  return (
    ui["kind"] !== "form" ||
    (isFormUi(ui) &&
      validFormResult(
        ui,
        settlement["result"],
        transcriptText,
        settlement["shownOptions"],
        settlement["settlementKind"] === "timedOut",
      ))
  );
}

const noPlan = () => new Error("The kept session has no plan.");
const eventGap = () => new RangeError("The kept session's events have a gap.");
const missingRoom = () => new Error("This script has no debug room.");

function checkedEntries(entries: readonly RuntimeScriptStorageEntrySnapshot[]): void {
  const failure = validateScriptStorageEntries(entries, "entries");
  if (failure !== null) throw new TypeError(failure);
}

function writtenEntries(
  entries: readonly RuntimeScriptStorageEntrySnapshot[],
  key: string,
  value: RuntimeScriptStorageEntrySnapshot["value"] | null,
): RuntimeScriptStorageEntrySnapshot[] {
  const others = entries.filter((entry) => entry.key !== key);
  if (value === null) return others;
  const entry = { key, value };
  checkedEntries([entry]);
  return [...others, entry];
}

/** Stored values when they are valid script storage; they come from storage, so they are checked on every read. */
function loadedEntries(values: unknown): readonly RuntimeScriptStorageEntrySnapshot[] {
  if (validateScriptStorageEntries(values, "values") !== null)
    throw new Error("The debug room's saved data is unreadable.");
  // EVIDENCE: validation: validateScriptStorageEntries accepted the stored values above.
  return values as readonly RuntimeScriptStorageEntrySnapshot[];
}

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

/** A room store in this page's memory, for a browser without IndexedDB; a reload ends its rooms. */
export function memoryKeptRoomStore(): KeptRoomStore {
  const sessions = memoryKeptSessionStore();
  const rooms = new Map<string, readonly RuntimeScriptStorageEntrySnapshot[]>();
  const room = (scope: string) => {
    const values = rooms.get(scope);
    if (values === undefined) throw missingRoom();
    return values;
  };
  return {
    ...sessions,
    read: async (scope) =>
      rooms.has(scope) ? { session: (await sessions.session(scope)) !== null } : null,
    async create(scope, entries, photos) {
      checkedEntries(entries);
      if (rooms.has(scope)) throw new Error("This script has a debug room already.");
      await sessions.discard(scope);
      rooms.set(scope, [...entries]);
      for (const photo of photos) await sessions.media.add({ ...photo, namespace: scope });
    },
    values: (scope) => ({
      scope,
      load: async () => room(scope),
      write: async (key, value) => void rooms.set(scope, writtenEntries(room(scope), key, value)),
      replace: async (entries) => {
        checkedEntries(entries);
        room(scope);
        rooms.set(scope, [...entries]);
      },
      clear: async () => {
        room(scope);
        rooms.set(scope, []);
      },
    }),
    async discard(scope) {
      rooms.delete(scope);
      await sessions.discard(scope);
    },
  };
}

// 2: keeps each session's plan in a record of its own in `plans`, so keeping a step rewrites only what changed.
const DATABASE_VERSION = 2;
const ROOMS = "rooms";
const SESSIONS = "sessions";
const PLANS = "plans";
const EVENTS = "events";
const MEDIA = "media";

/**
 * Opens the kept sessions of this browser in IndexedDB (`teasescript-kept-sessions`): sessions and their plans by scope,
 * events by scope and position, and photos by scope and reference. Each operation is one transaction. Rejects when IndexedDB is unavailable
 * or refused.
 */
export async function openIndexedDbKeptSessionStore(
  name = "teasescript-kept-sessions",
): Promise<KeptSessionStore> {
  return indexedDbStore(await openDatabase(name, false));
}

/**
 * Opens the debug rooms of this browser in IndexedDB (`teasescript-debug-rooms`): as kept sessions, and each room's
 * saved values by scope. Each operation is one transaction. Rejects when IndexedDB is unavailable or refused.
 */
export async function openIndexedDbKeptRoomStore(
  name = "teasescript-debug-rooms",
): Promise<KeptRoomStore> {
  return indexedDbRoomStore(await openDatabase(name, true));
}

function openDatabase(name: string, rooms: boolean): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new DOMException("IndexedDB is unavailable.", "NotSupportedError"));
      return;
    }
    const request = indexedDB.open(name, DATABASE_VERSION);
    request.onupgradeneeded = (event) => {
      const database = request.result;
      if (event.oldVersion === 0) {
        if (rooms) database.createObjectStore(ROOMS, { keyPath: "scope" });
        database.createObjectStore(SESSIONS, { keyPath: "scope" });
        database.createObjectStore(EVENTS);
        database.createObjectStore(MEDIA, { keyPath: ["namespace", "reference"] });
      } else {
        // Sessions kept in version 1, each with its plan, are not carried over: their scripts show Start (owner
        // decision, 2026-10-09). A debug room keeps its saved values and photos; kept sessions' photos go with them.
        const upgrade = request.transaction!;
        upgrade.objectStore(SESSIONS).clear();
        upgrade.objectStore(EVENTS).clear();
        if (!rooms) upgrade.objectStore(MEDIA).clear();
      }
      database.createObjectStore(PLANS, { keyPath: "scope" });
    };
    request.onblocked = () =>
      reject(new DOMException("Kept session storage is blocked.", "InvalidStateError"));
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      // Another tab upgrading the database needs this connection closed.
      database.onversionchange = () => database.close();
      resolve(database);
    };
  });
}

// Every key [scope, …] sorts between [scope] and [scope, []]: arrays sort after numbers and strings.
const scopeRange = (scope: string) => IDBKeyRange.bound([scope], [scope, []]);
const eventsFrom = (scope: string, from: number) =>
  IDBKeyRange.bound([scope, from], [scope, Infinity]);

/**
 * Runs `work` in one transaction of `database` over `stores` and resolves with its result once the transaction committed;
 * `work` receives a `fail` that aborts the transaction with an error, so nothing it wrote stays.
 */
function transact<T>(
  database: IDBDatabase,
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
    // A request's error reaches the transaction before the transaction has an error of its own, so it is the cause.
    transaction.onerror = (event) =>
      reject(failure ?? requestError(event) ?? new DOMException("Aborted.", "AbortError"));
    transaction.onabort = () =>
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

/** The error of the request an `error` event comes from, or `null`. */
const requestError = (event: Event) =>
  event.target instanceof IDBRequest ? event.target.error : null;

const got = <T>(request: IDBRequest<T>, then: (value: T) => void) => {
  request.onsuccess = () => then(request.result);
};

function indexedDbStore(database: IDBDatabase): KeptSessionStore {
  return {
    session: (scope) =>
      transact(database, [SESSIONS, PLANS, EVENTS], "readonly", (transaction, done) =>
        got(
          transaction.objectStore(SESSIONS).get(scope),
          (session: Record<string, unknown> | undefined) => {
            if (session === undefined) return done(null);
            got(
              transaction.objectStore(PLANS).get(scope),
              (plan: Record<string, unknown> | undefined) =>
                got(transaction.objectStore(EVENTS).getAll(eventsFrom(scope, 0)), (events) =>
                  done({
                    planJson: plan?.["planJson"],
                    snapshotJson: session["snapshotJson"],
                    marks: session["marks"],
                    events,
                  }),
                ),
            );
          },
        ),
      ),
    // The plan never changes while the session runs, so it is written only when it is given, which the session's first
    // step does, and goes with the session: a later step reads and writes only the snapshot, marks, event count, and new
    // events, and its plan is there whenever its session is.
    publish: (scope, update) =>
      transact<void>(
        database,
        [SESSIONS, PLANS, EVENTS],
        "readwrite",
        (transaction, _done, fail) => {
          const sessions = transaction.objectStore(SESSIONS);
          if (update.planJson !== null)
            transaction.objectStore(PLANS).put({ scope, planJson: update.planJson });
          got(sessions.get(scope), (previous: Record<string, unknown> | undefined) => {
            if (update.planJson === null && previous === undefined) return fail(noPlan());
            const eventCount = previous?.["eventCount"] ?? 0;
            if (typeof eventCount !== "number" || update.eventsFrom > eventCount)
              return fail(eventGap());
            const events = transaction.objectStore(EVENTS);
            events.delete(eventsFrom(scope, update.eventsFrom));
            update.events.forEach((event, index) =>
              events.put(event, [scope, update.eventsFrom + index]),
            );
            sessions.put({
              scope,
              snapshotJson: update.snapshotJson,
              marks: update.marks,
              eventCount: update.eventsFrom + update.events.length,
            });
          });
        },
      ),
    media: {
      get: (namespace, reference) =>
        transact(database, [MEDIA], "readonly", (transaction, done) =>
          got(transaction.objectStore(MEDIA).get([namespace, reference]), (record) =>
            done(record ?? null),
          ),
        ),
      // `add`, unlike `put`, fails instead of overwriting an existing record. Each keep offers every photo of the
      // session, so one kept already fails before its bytes are read again.
      add: async (record) => {
        const key = [record.namespace, record.reference];
        const kept = await transact<boolean>(database, [MEDIA], "readonly", (transaction, done) =>
          got(transaction.objectStore(MEDIA).getKey(key), (found) => done(found !== undefined)),
        );
        if (kept) throw new DOMException("The photo is stored already.", "ConstraintError");
        const stored = await storableCapturedMedia(record);
        return transact<void>(database, [MEDIA], "readwrite", (transaction) => {
          transaction.objectStore(MEDIA).add(stored);
        });
      },
      delete: (namespace, reference) =>
        transact<void>(database, [MEDIA], "readwrite", (transaction) => {
          transaction.objectStore(MEDIA).delete([namespace, reference]);
        }),
      listReferences: (namespace) =>
        transact(database, [MEDIA], "readonly", (transaction, done) =>
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
      transact<void>(database, [SESSIONS, PLANS, EVENTS, MEDIA], "readwrite", (transaction) => {
        transaction.objectStore(SESSIONS).delete(scope);
        transaction.objectStore(PLANS).delete(scope);
        transaction.objectStore(EVENTS).delete(scopeRange(scope));
        transaction.objectStore(MEDIA).delete(scopeRange(scope));
      }),
  };
}

function indexedDbRoomStore(database: IDBDatabase): KeptRoomStore {
  const sessions = indexedDbStore(database);
  /** Changes the scope's saved values within one transaction; fails without a room. */
  const changeValues = (
    scope: string,
    change: (
      values: readonly RuntimeScriptStorageEntrySnapshot[],
    ) => readonly RuntimeScriptStorageEntrySnapshot[],
  ) =>
    transact<void>(database, [ROOMS], "readwrite", (transaction, _done, fail) => {
      const rooms = transaction.objectStore(ROOMS);
      got(rooms.get(scope), (room: { values?: unknown } | undefined) => {
        if (room === undefined) return fail(missingRoom());
        try {
          rooms.put({ scope, values: change(loadedEntries(room.values)) });
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
  return {
    ...sessions,
    read: (scope) =>
      transact(database, [ROOMS, SESSIONS], "readonly", (transaction, done) =>
        got(transaction.objectStore(ROOMS).getKey(scope), (room) => {
          if (room === undefined) return done(null);
          got(transaction.objectStore(SESSIONS).getKey(scope), (session) =>
            done({ session: session !== undefined }),
          );
        }),
      ),
    create(scope, entries, photos) {
      checkedEntries(entries);
      // The photos' bytes are read before the transaction starts, which commits once no request of it is pending.
      return Promise.all(photos.map(storableCapturedMedia)).then((stored) =>
        transact<void>(
          database,
          [ROOMS, SESSIONS, PLANS, EVENTS, MEDIA],
          "readwrite",
          (transaction) => {
            // Nothing of an earlier room may stay; `add` fails when the scope has a room.
            transaction.objectStore(SESSIONS).delete(scope);
            transaction.objectStore(PLANS).delete(scope);
            transaction.objectStore(EVENTS).delete(scopeRange(scope));
            transaction.objectStore(MEDIA).delete(scopeRange(scope));
            transaction.objectStore(ROOMS).add({ scope, values: [...entries] });
            for (const photo of stored)
              transaction.objectStore(MEDIA).add({ ...photo, namespace: scope });
          },
        ),
      );
    },
    values: (scope) => ({
      scope,
      load: () =>
        transact(database, [ROOMS], "readonly", (transaction, done, fail) =>
          got(
            transaction.objectStore(ROOMS).get(scope),
            (room: { values?: unknown } | undefined) => {
              if (room === undefined) return fail(missingRoom());
              try {
                done(loadedEntries(room.values));
              } catch (error) {
                fail(error instanceof Error ? error : new Error(String(error)));
              }
            },
          ),
        ),
      write: (key, value) => changeValues(scope, (values) => writtenEntries(values, key, value)),
      replace: (entries) => {
        checkedEntries(entries);
        return changeValues(scope, () => [...entries]);
      },
      clear: () => changeValues(scope, () => []),
    }),
    discard: (scope) =>
      transact<void>(
        database,
        [ROOMS, SESSIONS, PLANS, EVENTS, MEDIA],
        "readwrite",
        (transaction) => {
          transaction.objectStore(ROOMS).delete(scope);
          transaction.objectStore(SESSIONS).delete(scope);
          transaction.objectStore(PLANS).delete(scope);
          transaction.objectStore(EVENTS).delete(scopeRange(scope));
          transaction.objectStore(MEDIA).delete(scopeRange(scope));
        },
      ),
  };
}
