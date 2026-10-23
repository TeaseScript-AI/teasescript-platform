import { shallowRef, type ShallowRef } from "vue";
import type { RuntimePlayerProfileInput } from "../../../src/runtime/host-data/player-profile.js";
import { uncoordinatedCapturedMediaLocks } from "../../captured-media-persistence.js";
import { openIndexedDbMediaRepository } from "../../indexeddb-media-repository.js";
import {
  memoryKeptRoomStore,
  memoryKeptSessionStore,
  openIndexedDbKeptRoomStore,
  openIndexedDbKeptSessionStore,
} from "../../kept-sessions.js";
import {
  onlineKeptSessions,
  onlineMediaRepository,
  onlineSavedScripts,
  onlineScriptStorage,
  readOnlineAccount,
} from "../../online-data.js";
import type { PlayerDataContext } from "../../player-data.js";
import { browserSavedData, savedDataHost } from "../../saved-data.js";
import { createLocalScriptStorage } from "../../script-storage.js";
import { browserStorage } from "./usePlayerPreference";
import type { PlayerSessionOptions } from "./usePlayerSession";

/**
 * Every store of the player's data in one data mode (`player-data.ts`), which the composition root opens once before
 * the Player mounts: the sessions it creates use only these, so the two modes never share data.
 */
export interface PlayerStores {
  /** The session options for a script's storage scope: its saved values, photos, kept session, and debug room. */
  storage(
    scope: string,
  ): Pick<
    PlayerSessionOptions,
    "scriptStorage" | "capturedMedia" | "savedData" | "keptSessions" | "debugRooms"
  >;
  /** The person fields of the account's player profile, which replace the script host's; stand-alone keeps the host's. */
  readonly playerProfile?: RuntimePlayerProfileInput;
  /**
   * Stand-alone only: whether the browser keeps the data until the player deletes it, `null` while unknown or when the
   * browser cannot tell.
   */
  readonly persistent?: Readonly<ShallowRef<boolean | null>>;
}

/**
 * Opens the stores of `context`'s mode. Stand-alone keeps everything in this browser. Online keeps saved values,
 * photos, the saved-data list, and the kept sessions on the server and reads the account's player profile, rejecting
 * with an `OnlineDataError` when the server cannot give it; its debug rooms stay in this browser, in a database of the
 * server's account alone.
 */
export async function openPlayerStores(context: PlayerDataContext): Promise<PlayerStores> {
  if (context.mode === "standalone") {
    // Durable captured and chosen media; when IndexedDB is unavailable, it stays session media.
    const repository = await openIndexedDbMediaRepository().catch(() => null);
    // Kept sessions and debug rooms outlive a reload and a closed browser; without IndexedDB they last as long as the
    // page.
    const [keptSessions, debugRooms] = await Promise.all([
      openIndexedDbKeptSessionStore().catch(() => memoryKeptSessionStore()),
      openDebugRooms(""),
    ]);
    const kept = { keptSessions, debugRooms };
    const savedData = browserSavedData(browserStorage(), repository, kept.keptSessions);
    const persistent = shallowRef<boolean | null>(null);
    void persistentStorage().then((granted) => (persistent.value = granted));
    const capturedMedia = { repository };
    return {
      storage: (scope) => ({
        scriptStorage: createLocalScriptStorage(browserStorage(), scope),
        capturedMedia,
        savedData,
        ...kept,
      }),
      persistent,
    };
  }
  const { account, profile } = await readOnlineAccount(context);
  // Other devices of the account are not seen, so no Player sweeps the server's media; this browser's Web Locks, named
  // by scope alone, would also tie its Players to stand-alone ones.
  const capturedMedia = {
    repository: onlineMediaRepository(context),
    locks: uncoordinatedCapturedMediaLocks(),
  };
  const kept = {
    keptSessions: onlineKeptSessions(context),
    debugRooms: await openDebugRooms(`:online:${JSON.stringify([context.server, account])}`),
  };
  const savedData = savedDataHost(
    { ...onlineSavedScripts(context), provider: (scope) => onlineScriptStorage(context, scope) },
    capturedMedia.repository,
    kept.keptSessions,
    capturedMedia.locks,
  );
  return {
    storage: (scope) => ({
      scriptStorage: onlineScriptStorage(context, scope),
      capturedMedia,
      savedData,
      ...kept,
    }),
    playerProfile: profile,
  };
}

/**
 * The debug rooms of this browser, apart for each data mode and account; without IndexedDB they last as long as the
 * page.
 */
function openDebugRooms(suffix: string) {
  return openIndexedDbKeptRoomStore(`teasescript-debug-rooms${suffix}`).catch(() =>
    memoryKeptRoomStore(),
  );
}

/**
 * Asks the browser to keep this origin's data until the player deletes it, unless it does already; `null` when the
 * browser cannot tell. A browser may decide by itself or ask the player.
 */
async function persistentStorage(): Promise<boolean | null> {
  const storage = typeof navigator === "undefined" ? undefined : navigator.storage;
  if (storage?.persist === undefined) return null;
  try {
    return (await storage.persisted()) || (await storage.persist());
  } catch {
    return null;
  }
}
