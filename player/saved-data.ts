import { keptPhotoReferences, type KeptSessionStore } from "./kept-sessions.js";
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

/** A script the player keeps saved data for. */
export interface SavedDataScript {
  readonly scope: string;
  readonly name: string | null;
}

/**
 * The saved data of every script the player has played, as the player's own: what export and import of all saved data
 * read and write, whichever script the Player shows. A script's data stays in its own scope.
 */
export interface SavedDataHost {
  /**
   * The scripts the player keeps saved data for, by scope, each with its title as a Player last showed it, or `null`;
   * rejects when the saved data cannot be read.
   */
  scripts(): Promise<readonly SavedDataScript[]>;
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
  keptSessions?: KeptSessionStore,
  locks: CapturedMediaLocks = browserCapturedMediaLocks(),
): SavedDataHost {
  const name = (scope: string): string | null => {
    try {
      return storage?.getItem(NAME_PREFIX + JSON.stringify(scope)) ?? null;
    } catch {
      return null;
    }
  };
  return savedDataHost(
    {
      scripts: async () =>
        listLocalScriptStorageScopes(storage).map((scope) => ({ scope, name: name(scope) })),
      rememberName(scope, name) {
        try {
          storage?.setItem(NAME_PREFIX + JSON.stringify(scope), name);
        } catch {
          // Without the name, the scope lists by its id.
        }
      },
      provider: (scope) => createLocalScriptStorage(storage, scope),
    },
    repository,
    keptSessions,
    locks,
  );
}

/**
 * The saved data that `listing` lists and provides, with its photos in `repository`: a Player's photos are stored before
 * the values that reference them, and the photos a kept session uses stay stored.
 */
export function savedDataHost(
  listing: Pick<SavedDataHost, "scripts" | "rememberName" | "provider">,
  repository: CapturedMediaRepository | null,
  keptSessions?: KeptSessionStore,
  locks: CapturedMediaLocks = browserCapturedMediaLocks(),
): SavedDataHost {
  return {
    scripts: () => listing.scripts(),
    rememberName: (scope, name) => listing.rememberName(scope, name),
    provider: (scope) => listing.provider(scope),
    media: (scope) => new CapturedMediaStore(repository, browserMediaUrls, scope),
    persistence(scope) {
      const media = new CapturedMediaStore(repository, browserMediaUrls, scope);
      return {
        // The photos a script's kept session uses stay stored, as its Player keeps them (PLAYER-UI "Session start").
        storage: capturedMediaStorage(
          listing.provider(scope),
          media,
          locks,
          keptPhotoReferences(keptSessions),
        ),
        media,
      };
    },
  };
}
