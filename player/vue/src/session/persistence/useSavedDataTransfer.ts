import type { Ref } from "vue";
import { browserMediaUrls } from "../../../../browser-capture.js";
import { CapturedMediaNotStoredError, CapturedMediaStore } from "../../../../captured-media.js";
import {
  withCapturedMedia,
  type CapturedMediaStorage,
} from "../../../../captured-media-persistence.js";
import type { ImageDecoder } from "../../../../image-file.js";
import { StaleOperation, type PersistenceOwnership } from "../../../../persistence-ownership.js";
import type { ScriptStorageProvider } from "../../../../script-storage.js";
import {
  checkStorageTransferImages,
  collectSavedScript,
  remapCapturedMediaReferences,
  StorageTransferError,
  type CheckedTransferImage,
  type SavedScript,
  type StorageBundle,
  type StorageBundleScript,
} from "../../../../storage-transfer.js";
import type { RuntimeScriptStorageEntrySnapshot } from "../../../../../src/index.js";
import type { Problem } from "../../ProblemCard.vue";
import type { PlayerSessionOptions, PlayerSessionStart } from "../../usePlayerSession.js";
import type { useKeptSession } from "./useKeptSession.js";
import type { useSavedValues } from "./useSavedValues.js";

/*
 * Export and import of saved data, of this script and of every script the browser keeps, moved from `usePlayerSession`
 * unchanged.
 */

/** What the saved data's export and import need from the Player's session composable. */
interface SavedDataTransferHost {
  readonly options: PlayerSessionOptions;
  readonly scriptStorage: ScriptStorageProvider | undefined;
  readonly normalStorage: ScriptStorageProvider | undefined;
  readonly room: Readonly<Ref<"normal" | "debug">>;
  readonly capturedMedia: CapturedMediaStore;
  readonly capturedMediaPersistence: CapturedMediaStorage | undefined;
  readonly decodeImage: ImageDecoder;
  readonly importing: Readonly<Ref<boolean>>;
  readonly clearing: Readonly<Ref<boolean>>;
  readonly holdImporting: () => () => void;
  readonly readScriptStorage: ReturnType<typeof useSavedValues>["readScriptStorage"];
  readonly applyScriptStorage: ReturnType<typeof useSavedValues>["applyScriptStorage"];
  readonly operationStorage: (owner: PersistenceOwnership) => ScriptStorageProvider;
  readonly keptOwner: ReturnType<typeof useKeptSession>;
  readonly nextPreparation: () => number;
  readonly persistenceOwnership: (owner?: number | null) => PersistenceOwnership;
  readonly owned: (
    ownership: PersistenceOwnership,
    operation: () => Promise<void>,
  ) => Promise<boolean>;
  readonly activation: Readonly<Ref<{ readonly outdated?: Problem } | null>>;
  readonly lastStart: Readonly<Ref<PlayerSessionStart | null>>;
  readonly inspecting: Readonly<Ref<boolean>>;
  readonly endSession: () => void;
  readonly retireRewind: (by: "clear" | "import" | "loss") => void;
  readonly prepareStart: (create: PlayerSessionStart, outdated?: Problem) => void;
  /** Whether a session runs, waits for Continue, or is starting; made after this owner. */
  readonly sessionInProgress: () => Readonly<Ref<boolean>>;
}

export function useSavedDataTransfer({
  options,
  scriptStorage,
  normalStorage,
  room,
  capturedMedia,
  capturedMediaPersistence,
  decodeImage,
  importing,
  clearing,
  holdImporting,
  readScriptStorage,
  applyScriptStorage,
  operationStorage,
  keptOwner,
  nextPreparation,
  persistenceOwnership,
  owned,
  activation,
  lastStart,
  inspecting,
  endSession,
  retireRewind,
  prepareStart,
  sessionInProgress,
}: SavedDataTransferHost) {
  /** The saved data of every script this browser keeps, for an export; scripts without values are left out. */
  async function savedScripts(): Promise<readonly SavedScript[]> {
    const scopes = new Set(options.savedData?.scopes() ?? []);
    if (scriptStorage) scopes.add(scriptStorage.scope);
    const saved: SavedScript[] = [];
    for (const scope of [...scopes].sort()) {
      const name = options.savedData?.name(scope) ?? null;
      let script: SavedScript;
      // This Player's script is read through its own storage, after the saves its session issued; the debug room is
      // never exported.
      if (scope === scriptStorage?.scope) {
        if (room.value === "normal")
          script = await collectSavedScript(scriptStorage, capturedMedia, name);
        else {
          const media = ownStoredMedia(scope);
          try {
            script = await collectSavedScript(normalStorage!, media, name);
          } finally {
            media.close();
          }
        }
      } else if (options.savedData) {
        const media = options.savedData.media(scope);
        try {
          script = await collectSavedScript(options.savedData.provider(scope), media, name);
        } finally {
          media.close();
        }
      } else continue;
      if (script.script.entries.length > 0) saved.push(script);
    }
    return saved;
  }
  /**
   * Checks exported saved data for an import, all of it, photos included, and compares each script with what this
   * browser keeps now; nothing changes yet. Rejects with a `StorageTransferError` naming the problem.
   */
  async function reviewSavedDataImport(bundle: StorageBundle): Promise<SavedDataImportReview> {
    const images = await checkStorageTransferImages(bundle.images, decodeImage);
    const scripts: SavedDataImportScript[] = [];
    for (const script of bundle.scripts) {
      const own = script.scope === scriptStorage?.scope;
      if (!own && !options.savedData)
        throw new StorageTransferError(
          "This Player can import only the saved data of the script it shows.",
        );
      let current: readonly RuntimeScriptStorageEntrySnapshot[];
      try {
        current = own
          ? await (room.value === "normal" ? scriptStorage! : normalStorage!).load()
          : await options.savedData!.provider(script.scope).load();
      } catch {
        throw new StorageTransferError(
          "This browser's saved data cannot be read, so nothing can be imported.",
        );
      }
      scripts.push({
        scope: script.scope,
        name: script.name ?? options.savedData?.name(script.scope) ?? null,
        values: script.entries.length,
        photos: script.photos.length,
        currentValues: current.length,
        // The debug room's session does not use the script's own saved data, so an import does not end it.
        shown: own && room.value === "normal",
      });
    }
    return { bundle, images, scripts };
  }
  /**
   * Imports the chosen scripts of a reviewed bundle, each replacing its own scope's saved data at once, photos stored
   * first under new references. When this Player's script is among them, a session in progress ends first and Start is
   * offered with the imported data. A script that fails keeps its saved data; the rejection names it, and the scripts
   * imported before it stay imported. Unchosen scripts are untouched.
   *
   * The import is a persistence operation of this page (`persistence-ownership.ts`): this page's own writes and effects
   * go through its ownership, which a move of the page retires, so a stale import shows and says nothing. Another
   * script's saved data are the player's confirmed writes for a script this page does not show: no state of this page
   * retires them, and they finish (`importOtherScript`).
   */
  async function importSavedData(
    review: SavedDataImportReview,
    chosen: ReadonlySet<string>,
  ): Promise<void> {
    if (importing.value || clearing.value)
      throw new StorageTransferError("Saved data cannot be replaced right now.");
    // In the debug room an import replaces the script's own saved data, which the debug room and its session do not use.
    const inDebugRoom = room.value === "debug";
    const ownChosen =
      scriptStorage !== undefined && chosen.has(scriptStorage.scope) && !inDebugRoom;
    const releaseImporting = holdImporting();
    // Start keeps saying why the kept session cannot continue while a failed import leaves that session.
    let outdated = ownChosen ? activation.value?.outdated : undefined;
    // Debug's rewind could restore this script's earlier saved data over the import, so its history ends too, and so
    // does an inspected state, also one that ended.
    if (ownChosen) {
      if (sessionInProgress().value || inspecting.value) endSession();
      retireRewind("import");
    }
    // Then the import is a preparation of its own: a Continue or Start still being prepared for the script would offer
    // what it replaces. It takes its number after the session it ends, which takes one itself.
    const ctx = persistenceOwnership(ownChosen ? nextPreparation() : null);
    const failed: string[] = [];
    const importScripts = async (): Promise<void> => {
      // A session being kept is kept before the import discards it.
      if (ownChosen) while (keptOwner.keepingNow() !== null) await keptOwner.keepingNow();
      for (const script of review.bundle.scripts) {
        if (!chosen.has(script.scope)) continue;
        try {
          if (script.scope !== scriptStorage?.scope) {
            await importOtherScript(script, review.images);
            continue;
          }
          // Without durable captured media, imported photos would not outlive this page.
          if (capturedMediaPersistence === undefined && usesImages(script))
            throw new CapturedMediaNotStoredError("This Player cannot keep saved photos.");
          // The script's next session loads the imported values: its kept session, with its older view, goes first,
          // and a script whose kept session stays keeps its saved data.
          await ctx.kept(keptOwner.keptSessionsNow()).discard(script.scope);
          outdated = undefined;
          if (inDebugRoom) await replaceOwnInDebugRoom(ctx, script, review.images);
          else await replaceScript(operationStorage(ctx), capturedMedia, script, review.images);
        } catch (error) {
          // This page's write was refused: the page moved on, and the import goes on with the other scripts.
          if (error instanceof StaleOperation) continue;
          failed.push(
            `${script.name ?? script.scope} (${error instanceof CapturedMediaNotStoredError ? "its photos could not be stored" : "it could not be saved, for example because storage is full"})`,
          );
        }
      }
    };
    // An error no step expects is thrown once the import is done, as before.
    const unexpected = await importScripts().then(
      () => null,
      (error: unknown) => ({ error }),
    );
    // This page's end of the import, while it owns the page: the saved values it stored, then Start. `ranToEnd` says
    // whether that end ran whole, or, with no end of this page's, whether the page still owns the import.
    const ranToEnd = ownChosen
      ? await owned(ctx, async () => {
          ctx.check();
          const stored = await readScriptStorage(operationStorage(ctx), ctx);
          ctx.commit(() => applyScriptStorage(stored));
          releaseImporting();
          ctx.commit(() => {
            if (lastStart.value !== null && !sessionInProgress().value)
              prepareStart(lastStart.value, outdated);
          });
        })
      : ctx.current();
    keptOwner.endOwnership(ctx);
    releaseImporting();
    if (unexpected !== null) throw unexpected.error;
    // A stale import says nothing: the page moved on.
    if (failed.length > 0 && ranToEnd)
      throw new StorageTransferError(
        `Not imported, and their saved data is unchanged: ${failed.join("; ")}. Any other chosen script was imported.`,
      );
  }
  /** Replaces the script's own saved data while the debug room is shown, for the persistence operation `ctx`. */
  async function replaceOwnInDebugRoom(
    ctx: PersistenceOwnership,
    script: StorageBundleScript,
    images: readonly CheckedTransferImage[],
  ): Promise<void> {
    const media = ownStoredMedia(script.scope);
    const storage = withCapturedMedia(options.scriptStorage!, media);
    try {
      await replaceScript(storage.forOperation(ctx), media, script, images);
    } finally {
      await storage.drain();
      media.close();
    }
  }
  /**
   * Imports another script's saved data, which this page does not show: its kept session goes first, then its values,
   * with their photos. These are the player's confirmed writes; no state of this page retires them.
   */
  async function importOtherScript(
    script: StorageBundleScript,
    images: readonly CheckedTransferImage[],
  ): Promise<void> {
    await keptOwner.keptSessionsNow().discard(script.scope);
    const { storage, media } = options.savedData!.persistence(script.scope);
    try {
      await replaceScript(storage, media, script, images);
    } finally {
      await storage.close();
      media.close();
    }
  }
  /** The script's own stored photos while the debug room is shown; close it after use. */
  function ownStoredMedia(scope: string): CapturedMediaStore {
    return new CapturedMediaStore(
      options.capturedMedia?.repository ?? null,
      browserMediaUrls,
      scope,
    );
  }

  return { savedScripts, reviewSavedDataImport, importSavedData };
}

/**
 * Replaces one script's saved data with its imported values: its own photos are added under new references first. Any
 * other reference in its values, such as another script's photo, stays the text it was.
 */
async function replaceScript(
  storage: ScriptStorageProvider,
  media: CapturedMediaStore,
  script: StorageBundleScript,
  images: readonly CheckedTransferImage[],
): Promise<void> {
  const own = new Set(script.photos);
  const references = new Map<string, string>();
  const added: string[] = [];
  try {
    for (const image of images) {
      if (!own.has(image.reference)) continue;
      const stored = media.add("image", image.data, { width: image.width, height: image.height });
      references.set(image.reference, stored.reference);
      added.push(stored.reference);
    }
    // Issued saves of an ended session finish first: storage runs its operations in issue order.
    await storage.replace(
      script.entries.map((entry) => ({
        key: entry.key,
        value: remapCapturedMediaReferences(entry.value, references),
      })),
    );
  } catch (error) {
    // Media stored before the failure is reclaimed later, as no saved value references it.
    for (const reference of added) media.discard(reference);
    throw error;
  }
}

function usesImages(script: StorageBundleScript): boolean {
  return script.photos.length > 0;
}

/** A checked import and how each script in it changes the saved data, shown before the player confirms it. */
export interface SavedDataImportReview {
  readonly bundle: StorageBundle;
  readonly images: readonly CheckedTransferImage[];
  readonly scripts: readonly SavedDataImportScript[];
}

export interface SavedDataImportScript {
  readonly scope: string;
  readonly name: string | null;
  readonly values: number;
  readonly photos: number;
  /** How many values are saved now; with none, the import adds the script. */
  readonly currentValues: number;
  /** Whether it is the script this Player shows, whose session an import ends. */
  readonly shown: boolean;
}
