import { browserMediaUrls } from "./browser-capture.js";
import { CapturedMediaStore, type CapturedMediaRepository } from "./captured-media.js";
import {
  browserCapturedMediaLocks,
  capturedMediaStorage,
  type CapturedMediaLocks,
  type CapturedMediaPersistence,
} from "./captured-media-persistence.js";
import {
  createLocalScriptStorage,
  listLocalScriptStorageScopes,
  type ScriptStorageProvider,
} from "./script-storage.js";

const NAME_PREFIX = "player-storage-name:";

/**
 * The saved data of every script this browser has played, as the player's own: what export and import of all saved
 * data read and write, whichever script the Player shows. A script's data stays in its own scope.
 */
export interface SavedDataHost {
  /** The scopes this browser keeps saved data for, in name order; rejects when storage cannot be used. */
  scopes(): readonly string[];
  /** The script's title as a Player last showed it, or `null`. */
  name(scope: string): string | null;
  /** Remembers a script's title for listing its saved data; storage problems are ignored. */
  rememberName(scope: string, name: string): void;
  /** Reads the scope's saved values. */
  provider(scope: string): ScriptStorageProvider;
  /** Reads the scope's stored photos; close it after use. */
  media(scope: string): CapturedMediaStore;
  /**
   * Writes the scope as a Player of it does: photos durable before the values, under the scope's live lock. Close it
   * after use, which finishes its writes and releases the lock.
   */
  persistence(scope: string): {
    readonly storage: CapturedMediaPersistence;
    readonly media: CapturedMediaStore;
  };
}

/** The saved data in this browser's local storage and captured-media repository. */
export function browserSavedData(
  storage: Storage | undefined,
  repository: CapturedMediaRepository | null,
  locks: CapturedMediaLocks = browserCapturedMediaLocks(),
): SavedDataHost {
  return {
    scopes: () => listLocalScriptStorageScopes(storage),
    name(scope) {
      try {
        return storage?.getItem(NAME_PREFIX + JSON.stringify(scope)) ?? null;
      } catch {
        return null;
      }
    },
    rememberName(scope, name) {
      try {
        storage?.setItem(NAME_PREFIX + JSON.stringify(scope), name);
      } catch {
        // Without the name, the scope lists by its id.
      }
    },
    provider: (scope) => createLocalScriptStorage(storage, scope),
    media: (scope) => new CapturedMediaStore(repository, browserMediaUrls, scope),
    persistence(scope) {
      const media = new CapturedMediaStore(repository, browserMediaUrls, scope);
      return {
        storage: capturedMediaStorage(createLocalScriptStorage(storage, scope), media, locks),
        media,
      };
    },
  };
}
