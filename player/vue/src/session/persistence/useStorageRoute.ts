import { ref, shallowRef } from "vue";
import { browserMediaUrls } from "../../../../media/browser-capture.js";
import { CapturedMediaStore, type CapturedMediaRecord } from "../../../../media/captured-media.js";
import {
  withCapturedMedia,
  type CapturedMediaStorage,
} from "../../../../media/captured-media-persistence.js";
import { memoryKeptRoomStore } from "../../../../persistence/kept-sessions.js";
import type { PersistenceOwnership } from "../../../../persistence/persistence-ownership.js";
import type { ScriptStorageProvider } from "../../../../persistence/script-storage.js";
import type { RuntimeScriptStorageEntrySnapshot } from "../../../../../src/index.js";
import type { PlayerSessionOptions } from "../usePlayerSession.js";

/*
 * Where the session composable's saved values and photos go, moved from `usePlayerSession` unchanged: the room shown,
 * the debug rooms, and the route storage operations take, with its switches between rooms.
 */

/** What the storage route needs from the Player's session composable. */
interface StorageRouteHost {
  readonly options: PlayerSessionOptions;
  readonly capturedMedia: CapturedMediaStore;
  /** The script's saved values that keep their captured media durable, or `undefined`. */
  readonly capturedMediaPersistence: CapturedMediaStorage | undefined;
  /** Ends the persistence operations a change retired (`persistenceOwnership`). */
  readonly retireStaleOperations: () => void;
}

export function useStorageRoute({
  options,
  capturedMedia,
  capturedMediaPersistence,
  retireStaleOperations,
}: StorageRouteHost) {
  // The script's own saved data, which the debug room leaves as they are.
  const normalStorage = capturedMediaPersistence ?? options.scriptStorage;
  // The room shown, whose session, saved values, and photos are in use (DEBUGGER.md "Debug room"): the script's own,
  // `normal`, or its debug room, `debug`, which the page's URL opens and Debug on in the normal room goes on in. Only a
  // script with storage has a debug room.
  const room = ref<"normal" | "debug">(
    options.room === "debug" && normalStorage !== undefined ? "debug" : "normal",
  );
  // The script's debug room, or `null` without one, and whether it keeps a session.
  let debugRooms = options.debugRooms ?? memoryKeptRoomStore();
  const debugRoom = shallowRef<{ readonly session: boolean } | null>(null);
  let debugRoomStorage: CapturedMediaStorage | null = null;
  /**
   * Where saved values go: a provider used as it is, or one that keeps their captured media durable, each with its view
   * for one persistence operation, whose ownership admits every call it makes (`persistence-ownership.ts`).
   */
  interface StorageRoute {
    readonly provider: ScriptStorageProvider;
    forOperation(owner: PersistenceOwnership): ScriptStorageProvider;
  }
  const plainRoute = (provider: ScriptStorageProvider): StorageRoute => ({
    provider,
    forOperation: (owner) => owner.values(provider),
  });
  const capturedRoute = (storage: CapturedMediaStorage): StorageRoute => ({
    provider: storage,
    forOperation: (owner) => storage.forOperation(owner),
  });
  const normalRoute: StorageRoute | undefined =
    capturedMediaPersistence === undefined
      ? options.scriptStorage && plainRoute(options.scriptStorage)
      : capturedRoute(capturedMediaPersistence);
  // Where storage operations go: the route in use, or a switch to another one, which operations issued meanwhile wait
  // for, in issue order.
  let storageRoute: StorageRoute | Promise<StorageRoute> | undefined = normalRoute;
  // The route the page shows: the one in use, and while a switch is pending the one it leaves; its resolution changes it.
  let shownRoute: StorageRoute | undefined = normalRoute;
  const routed = <T>(operation: (route: StorageRoute) => Promise<T>): Promise<T> => {
    const route = storageRoute!;
    return route instanceof Promise ? route.then(operation) : operation(route);
  };
  // This route's one job for the saved data's revision, which `useSavedValues` owns: it says when a change landed on the
  // route shown (`whenLanded`), which only the route can tell.
  let landed: (() => void) | null = null;
  /** `change`, made on `route`: once it resolved there, and that route is still the one shown, it says so. */
  const reported = (route: StorageRoute, change: Promise<void>): Promise<void> => {
    change.then(
      () => {
        if (route === shownRoute) landed?.();
      },
      () => {},
    );
    return change;
  };
  /** The saved values in use, for the persistence operation `owner`: every call it makes there is admitted. */
  const operationStorage = (owner: PersistenceOwnership): ScriptStorageProvider => ({
    scope: normalStorage!.scope,
    load: () => routed((route) => route.forOperation(owner).load()),
    write: (key, value) =>
      routed((route) => reported(route, route.forOperation(owner).write(key, value))),
    replace: (entries) =>
      routed((route) => reported(route, route.forOperation(owner).replace(entries))),
    clear: () => routed((route) => reported(route, route.forOperation(owner).clear())),
  });
  const storageProvider: ScriptStorageProvider | undefined = normalStorage && {
    scope: normalStorage.scope,
    load: () => routed((route) => route.provider.load()),
    write: (key, value) => routed((route) => reported(route, route.provider.write(key, value))),
    replace: (entries) => routed((route) => reported(route, route.provider.replace(entries))),
    clear: () => routed((route) => reported(route, route.provider.clear())),
  };
  /**
   * Sends storage operations where `next` resolves from now on, once the operations issued before have finished where
   * they were issued. `next` must not reject.
   */
  function switchStorage(next: () => Promise<StorageRoute>): Promise<void> {
    const previous = storageRoute!;
    const switched = (async () => {
      const { provider } = await previous;
      await (provider === debugRoomStorage ? debugRoomStorage : capturedMediaPersistence)?.flush();
      return next();
    })();
    storageRoute = switched;
    return switched.then((route) => {
      if (storageRoute !== switched) return;
      storageRoute = route;
      shownRoute = route;
    });
  }
  /** Sends saved values and photos to the scope's debug room, which exists; `durable` are its photos this Player holds. */
  function enterDebugRoom(
    scope: string,
    state: { readonly session: boolean },
    durable: ReadonlySet<string>,
  ): StorageRoute {
    capturedMedia.useRepository(debugRooms.media, durable);
    debugRoomStorage = withCapturedMedia(debugRooms.values(scope), capturedMedia);
    debugRoom.value = state;
    return capturedRoute(debugRoomStorage);
  }
  // The room the page opens is in use before a session is prepared; the debug room is made from a copy of the script's
  // own saved data when there is none yet.
  if (normalStorage !== undefined)
    void switchStorage(async () => {
      debugRoom.value = await debugRooms.read(normalStorage.scope).catch(() => null);
      if (room.value === "normal") return normalRoute!;
      const durable =
        debugRoom.value === null
          ? await createDebugRoom(normalStorage.scope, false)
          : new Set<string>();
      return enterDebugRoom(normalStorage.scope, debugRoom.value ?? { session: false }, durable);
    });
  /**
   * Stores a new debug room with a copy of the script's own saved values and photos as they are now, or none when
   * `empty`. Resolves to the references of the photos it copied, none when the room could not be created as a copy: the
   * Player then holds those photos itself.
   */
  async function createDebugRoom(scope: string, empty: boolean): Promise<ReadonlySet<string>> {
    let entries: readonly RuntimeScriptStorageEntrySnapshot[] = [];
    let photos: readonly CapturedMediaRecord[] = [];
    try {
      if (!empty) {
        entries = await normalStorage!.load();
        photos = await storedPhotos(scope);
      }
    } catch {
      // Saved data this browser cannot read is not copied; the debug room starts without it.
    }
    const all = () => new Set(photos.map((photo) => photo.reference));
    // The photos the room holds as copied, only once a creation that copied them succeeded.
    let copied: ReadonlySet<string> = new Set();
    try {
      await debugRooms.create(scope, entries, photos);
      copied = all();
    } catch {
      // Another tab created it meanwhile, or this browser cannot keep it: then it lives in this page.
      if ((await debugRooms.read(scope).catch(() => null)) === null) {
        debugRooms = memoryKeptRoomStore();
        retireStaleOperations();
        copied = await debugRooms
          .create(scope, entries, photos)
          .then(all, () => debugRooms.create(scope, [], []).then(() => new Set<string>()));
      }
    }
    // A photo the room did not take is held here, so a keep or save that uses it stores it in the room.
    for (const photo of photos)
      if (!copied.has(photo.reference)) capturedMedia.restoreSessionMedia(photo.reference, photo);
    return copied;
  }
  /** The script's stored photos, checked as the Player reads them. */
  async function storedPhotos(scope: string): Promise<readonly CapturedMediaRecord[]> {
    const repository = options.capturedMedia?.repository ?? null;
    if (repository === null) return [];
    const reader = new CapturedMediaStore(repository, browserMediaUrls, scope);
    try {
      const photos: CapturedMediaRecord[] = [];
      for (const reference of await repository.listReferences(scope)) {
        const record = await reader.read(reference);
        if (record !== null) photos.push(record);
      }
      return photos;
    } finally {
      reader.close();
    }
  }

  let handedOver = false;
  return {
    normalStorage,
    room,
    debugRoom,
    /**
     * Hands over the saved values' two entry points, each of which reports a change that landed on the route shown, and
     * `whenLanded`, which takes the one note of those reports: the revision's owner's (`useSavedValues`). A second call
     * of either throws, so that note has one taker.
     */
    handOverValues() {
      if (handedOver) throw new Error("The saved values' entry points were handed over already.");
      handedOver = true;
      return {
        storageProvider,
        operationStorage,
        whenLanded: (note: () => void) => {
          if (landed !== null) throw new Error("The saved values' change note is taken already.");
          landed = note;
        },
      };
    },
    switchStorage,
    enterDebugRoom,
    createDebugRoom,
    /** The debug rooms' store now: a page that cannot keep them changes to one in its memory. */
    debugRoomsNow: () => debugRooms,
    /** The debug room's saved values in use, or `null` before the debug room was entered. */
    debugRoomStorageNow: () => debugRoomStorage,
    /** The route storage operations take now, or the switch to another one under way. */
    storageRouteNow: () => storageRoute,
  };
}
