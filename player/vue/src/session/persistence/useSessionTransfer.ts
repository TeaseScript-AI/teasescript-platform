import { computed, type Ref } from "vue";
import type { CapturedMediaRecord, CapturedMediaStore } from "../../../../captured-media.js";
import type { CapturedMediaStorage } from "../../../../captured-media-persistence.js";
import { capturedMediaReferencesIn } from "../../../../kept-sessions.js";
import { bridgeOf, type PlayerBridge } from "../../../../player-bridge.js";
import { BridgeRequestError } from "../../../../engine-bridge/client.js";
import { StaleOperation, type PersistenceOwnership } from "../../../../persistence-ownership.js";
import type { PlayerRuntimeRestorePoint } from "../../../../runtime-adapter.js";
import type { PlayerSession } from "../../../../runtime-view.js";
import type { ScriptStorageProvider } from "../../../../script-storage.js";
import {
  sessionMediumRecord,
  sessionTransferMedium,
  type SessionTransfer,
  type SessionTransferMedium,
} from "../../../../session-transfer.js";
import { StorageTransferError, type StorageBundle } from "../../../../storage-transfer.js";
import type {
  InterpreterEvent,
  RuntimeScriptStorageEntrySnapshot,
} from "../../../../../src/index.js";
import type { PlayerSessionOptions } from "../../usePlayerSession.js";
import type { useKeptSession } from "./useKeptSession.js";
import { storedValueReferences, type useSavedValues } from "./useSavedValues.js";

/*
 * Export and import of a session of the script this Player shows, moved from `usePlayerSession` unchanged.
 */

/** What a session's export and import need from the Player's session composable. */
interface SessionTransferHost {
  readonly options: PlayerSessionOptions;
  /** The engine's host now, or `null` before it is ready. */
  readonly bridgeNow: () => PlayerBridge | null;
  readonly bridgeReady: Promise<PlayerBridge>;
  readonly session: Readonly<Ref<PlayerSession | null>>;
  readonly room: Readonly<Ref<"normal" | "debug">>;
  readonly scriptStorage: ScriptStorageProvider | undefined;
  readonly capturedMedia: CapturedMediaStore;
  readonly capturedMediaPersistence: CapturedMediaStorage | undefined;
  readonly clearing: Readonly<Ref<boolean>>;
  readonly importing: Readonly<Ref<boolean>>;
  readonly activation: Readonly<
    Ref<{ readonly kind: "start" | "continue"; readonly restored?: PlayerSession } | null>
  >;
  readonly liveSession: () => boolean;
  readonly inspecting: Readonly<Ref<boolean>>;
  readonly sessionInProgress: Readonly<Ref<boolean>>;
  readonly holdImporting: () => () => void;
  readonly endSession: () => void;
  readonly retireRewind: (by: "clear" | "import" | "loss") => void;
  readonly keptOwner: ReturnType<typeof useKeptSession>;
  readonly nextPreparation: () => number;
  readonly persistenceOwnership: (owner?: number | null) => PersistenceOwnership;
  readonly owned: (
    ownership: PersistenceOwnership,
    operation: () => Promise<void>,
  ) => Promise<boolean>;
  readonly operationStorage: (owner: PersistenceOwnership) => ScriptStorageProvider;
  readonly readScriptStorage: ReturnType<typeof useSavedValues>["readScriptStorage"];
  readonly applyScriptStorage: ReturnType<typeof useSavedValues>["applyScriptStorage"];
  readonly prepareKept: ReturnType<typeof useKeptSession>["prepareKept"];
  readonly settlePlanJson: ReturnType<typeof useKeptSession>["settlePlanJson"];
}

export function useSessionTransfer({
  options,
  bridgeNow,
  bridgeReady,
  session,
  room,
  scriptStorage,
  capturedMedia,
  capturedMediaPersistence,
  clearing,
  importing,
  activation,
  liveSession,
  inspecting,
  sessionInProgress,
  holdImporting,
  endSession,
  retireRewind,
  keptOwner,
  nextPreparation,
  persistenceOwnership,
  owned,
  operationStorage,
  readScriptStorage,
  applyScriptStorage,
  prepareKept,
  settlePlanJson,
}: SessionTransferHost) {
  /**
   * The session an export of the session takes (PLAYER-UI "Player Settings"): the shown one while it runs or waits, or the
   * one Continue goes on with; or why there is none. A debug room's session stays in its browser.
   */
  const exportableSession = computed(
    (): { readonly session: PlayerSession } | { readonly unavailable: string } => {
      if (keptOwner.keptScopeNow() === null || scriptStorage === undefined)
        return { unavailable: "This Player does not keep sessions." };
      if (room.value === "debug") return { unavailable: "A debug session stays in this browser." };
      if (clearing.value || importing.value)
        return { unavailable: "Not while saved data changes." };
      const pending = activation.value;
      if (pending?.kind === "continue" && pending.restored !== undefined)
        return { session: pending.restored };
      if (liveSession() && !inspecting.value) return { session: session.value! };
      return { unavailable: "Available while a session runs or waits for Continue." };
    },
  );
  /**
   * The session for an export, as it is now: its checkpoint and events, the script's saved values read after the saves it
   * issued, and every photo, recording, or file they use that this browser holds. Rejects with a `StorageTransferError`
   * saying why it cannot be exported.
   */
  async function exportSession(): Promise<SessionExport> {
    const found = exportableSession.value;
    if ("unavailable" in found) throw new StorageTransferError(found.unavailable);
    let restorePoint: PlayerRuntimeRestorePoint;
    try {
      const capture = await bridgeOf(found.session).read(found.session, "captureCheckpoint");
      restorePoint = Object.freeze({
        checkpointJson: capture.checkpointJson,
        events: Object.freeze(found.session.events.slice(0, capture.eventsThrough)),
      });
    } catch {
      throw new StorageTransferError(
        "This browser cannot keep the session as it is now, so it cannot be exported. Play on and try again later.",
      );
    }
    let entries: readonly RuntimeScriptStorageEntrySnapshot[];
    try {
      // Issued at once, so storage reads it after the saves the session issued until its state was taken.
      entries = await scriptStorage!.load();
    } catch {
      throw new StorageTransferError(
        "This browser's saved data cannot be read, so the session cannot be exported.",
      );
    }
    const references = capturedMediaReferencesIn(restorePoint.checkpointJson, restorePoint.events);
    for (const entry of entries)
      for (const reference of storedValueReferences([entry])) references.add(reference);
    const media: SessionTransferMedium[] = [];
    let missing = 0;
    for (const reference of references) {
      const record = await capturedMedia.read(reference);
      if (record === null) missing += 1;
      else media.push(await sessionTransferMedium(record));
    }
    return {
      transfer: {
        scope: keptOwner.keptScopeNow()!,
        name: options.savedData?.name(keptOwner.keptScopeNow()!) ?? null,
        session: restorePoint,
        entries,
        media,
      },
      missing,
    };
  }
  /**
   * Checks an exported session for an import into the script this Player shows, all of it; nothing changes yet. Rejects
   * with a `StorageTransferError` saying why it cannot continue here.
   */
  async function reviewSessionImport(transfer: SessionTransferRead): Promise<SessionImportReview> {
    try {
      return await reviewedImport(transfer);
    } catch (error) {
      // A session that cannot be imported here holds nothing in the host any more.
      discardSessionReview(transfer);
      throw error;
    }
  }
  async function reviewedImport(transfer: SessionTransferRead): Promise<SessionImportReview> {
    if (room.value === "debug")
      throw new StorageTransferError(
        "A session cannot be imported into the debug room. Open this script outside the debug room and import it there.",
      );
    if (
      keptOwner.keptScopeNow() === null ||
      keptOwner.scriptPlanNow() === null ||
      scriptStorage === undefined
    )
      throw new StorageTransferError(
        "This Player does not keep sessions, so it cannot import one.",
      );
    // Restored in the host against the held plan, as Continue would find it after a reload; its state stays there.
    const host = await bridgeReady;
    await asTransferError(
      host.client.request("reviewTransfer", {
        ticket: transfer.ticket,
        scope: keptOwner.keptScopeNow(),
        plan: keptOwner.scriptPlanNow(),
      }),
    );
    const saved = new Set(storedValueReferences(transfer.entries));
    // Without durable captured media, a saved value's photo would not outlive this page.
    if (
      capturedMediaPersistence === undefined &&
      transfer.media.some((medium) => saved.has(medium.reference))
    )
      throw new StorageTransferError(
        "This Player cannot keep saved photos or files, so it cannot import this session.",
      );
    // A reference this browser already holds keeps its record, which must be the same, so no reference silently names
    // other media.
    for (const [index, medium] of transfer.media.entries()) {
      const held = await capturedMedia.read(medium.reference);
      if (held !== null && !(await sameMedium(held, medium)))
        throw new StorageTransferError(
          `This browser keeps another photo or file under the reference of photo or file ${index + 1}, so this session cannot be imported.`,
        );
    }
    let current: readonly RuntimeScriptStorageEntrySnapshot[];
    try {
      current = await scriptStorage.load();
    } catch {
      throw new StorageTransferError(
        "This browser's saved data cannot be read, so nothing can be imported.",
      );
    }
    return {
      transfer,
      name: transfer.name ?? options.savedData?.name(keptOwner.keptScopeNow()!) ?? null,
      currentValues: current.length,
    };
  }
  /**
   * Reads an exported file's bytes or a pasted text of saved data or a session, in the host: saved data whole, a session
   * for `reviewSessionImport`. Rejects with a `StorageTransferError` saying why it cannot be read.
   */
  async function readTransfer(
    input: { readonly bytes: Uint8Array<ArrayBuffer> } | { readonly text: string },
  ): Promise<PlayerTransferRead> {
    const host = await bridgeReady;
    // EVIDENCE: validation: `readTransfer` replies from the same build with what it read.
    return (await asTransferError(host.client.request("readTransfer", input)))
      .result as PlayerTransferRead;
  }
  /** The tickets of the session imports under way, which `discardSessionReview` refuses. */
  const importedTickets = new Set<string>();
  /**
   * Lets go of a session read for an import that will not be imported: cancelled, replaced, or refused. Throws for one
   * whose import runs: that import still needs it, and lets the dialog go of it once it settles.
   */
  function discardSessionReview(transfer: SessionTransferRead): void {
    if (importedTickets.has(transfer.ticket))
      throw new Error(
        "A review being imported cannot be discarded: its import still needs the session read for it.",
      );
    void bridgeNow()
      ?.client.request("releaseTransfer", { ticket: transfer.ticket })
      .catch(() => {});
  }
  /**
   * Imports a reviewed session. A session of this script in progress ends first; the session's saved values replace the
   * script's at once, their photos and files stored first; then the session becomes the one this browser keeps for the
   * script, with the photos and files only it uses, and Continue is offered. Rejects with a `StorageTransferError` saying
   * what was imported when this browser could not store it.
   */
  async function importSession(review: SessionImportReview): Promise<void> {
    if (
      importing.value ||
      clearing.value ||
      room.value === "debug" ||
      keptOwner.keptScopeNow() === null ||
      keptOwner.scriptPlanNow() === null ||
      scriptStorage === undefined
    )
      throw new StorageTransferError(
        "A session cannot be imported right now. Try again in a moment.",
      );
    const { transfer } = review;
    const scope = keptOwner.keptScopeNow()!;
    const plan = keptOwner.scriptPlanNow()!;
    const releaseImporting = holdImporting();
    // A session of this script in progress ends first; Debug's rewind could restore this script's earlier saved data
    // over the import, so its history ends.
    if (sessionInProgress.value || inspecting.value) endSession();
    retireRewind("import");
    // The import is then a preparation of its own: a Continue or Start still being prepared would offer what it
    // replaces. It owns that preparation, in this room and plan tenure; once either moves on, it issues nothing more.
    const owner = nextPreparation();
    const ctx = persistenceOwnership(owner);
    // The saved values in use and the kept sessions, through the import's handles. The values the import stored are
    // shown by its final read, while it owns the page.
    const storage = operationStorage(ctx);
    const sessions = ctx.kept(keptOwner.keptSessionsNow());
    let failure: string | null = null;
    let ranToEnd = false;
    importedTickets.add(transfer.ticket);
    try {
      ranToEnd = await owned(ctx, async () => {
        const replaceSession = async (): Promise<void> => {
          // A session being kept is kept before the import replaces it.
          while (keptOwner.keepingNow() !== null) await keptOwner.keepingNow();
          ctx.check();
          // Each photo and file is held under the reference the session and the values hold, as a restored kept
          // session's are; a value's is stored when the values are. One held already is the same (`reviewSessionImport`).
          const added = transfer.media.filter((medium) => !capturedMedia.knows(medium.reference));
          ctx.commit(() => {
            for (const medium of added)
              capturedMedia.restoreSessionMedia(
                medium.reference,
                sessionMediumRecord(medium, scope),
              );
          });
          try {
            await storage.replace(transfer.entries);
          } catch {
            ctx.commit(() => {
              for (const medium of added) capturedMedia.discard(medium.reference);
            });
            failure =
              "Nothing was imported: this browser could not save the session's data, for example because storage is full.";
            return;
          }
          ctx.check();
          let discarded = false;
          try {
            ctx.commit(() => keptOwner.forgetKeptPoint());
            await sessions.discard(scope);
            discarded = true;
            ctx.check();
            // The state as the kept session stores it, and its events as the engine writes them, from the host.
            const host = await bridgeReady;
            ctx.check();
            const committed = (
              await ctx.admit(() =>
                host.client.request("transferCommit", { ticket: transfer.ticket }),
              )
            ).result;
            ctx.check();
            // EVIDENCE: validation: `transferCommit` replies from the same build with the reviewed state and events.
            const { snapshotJson, eventsJson } = committed as {
              readonly snapshotJson: string;
              readonly eventsJson: readonly string[];
            };
            const references = capturedMediaReferencesIn(snapshotJson, eventsJson);
            // Unlike keeping a session as it plays, every photo goes into a store the discard emptied, so a failure is
            // real: the session is not kept without the media it uses.
            for (const photo of capturedMedia.sessionRecords(references)) {
              await sessions.media.add(photo);
              ctx.check();
            }
            // The plan's JSON, which the host holds for the page (`plan-json-lease.ts`).
            ctx.commit(() => settlePlanJson({ kind: "prepare", plan }));
            const planJson = (await ctx.admit(() => host.client.request("planText", { plan })))
              .result;
            ctx.check();
            if (typeof planJson !== "string") throw new Error("The host wrote no plan JSON.");
            await sessions.publish(scope, {
              planJson,
              snapshotJson,
              eventsFrom: 0,
              events: transfer.events,
              eventsJson,
              marks: { editedWhileDebugging: null, rewoundWhileDebugging: null },
            });
          } catch (error) {
            if (error instanceof StaleOperation) throw error;
            failure = discarded
              ? "The session's saved data was imported, but this browser could not keep the session, for example because storage is full. Start begins a new session with that data."
              : "The session's saved data was imported, but this browser could not replace the session it kept for this script. Continue, if offered, goes on with that earlier session.";
          }
        };
        // An error no step expects is thrown once the import prepared, as a stale end is at once.
        const unexpected = await replaceSession().then(
          () => null,
          (error: unknown) => (error instanceof StaleOperation ? Promise.reject(error) : { error }),
        );
        // The import's own preparation, while it owns the page: the saved values it stored, and its Start or Continue.
        ctx.check();
        const stored = await readScriptStorage(operationStorage(ctx), ctx);
        ctx.commit(() => applyScriptStorage(stored));
        if (!(await prepareKept(owner, ctx))) throw new StaleOperation();
        if (unexpected !== null) throw unexpected.error;
      });
    } finally {
      importedTickets.delete(transfer.ticket);
      releaseImporting();
    }
    // A stale import says nothing: the page moved on.
    if (failure !== null && ranToEnd) throw new StorageTransferError(failure);
  }

  return {
    exportableSession,
    exportSession,
    readTransfer,
    reviewSessionImport,
    discardSessionReview,
    importSession,
  };
}

/**
 * `request`'s answer; a refusal the host gave as a `StorageTransferError` is one here too, with its words. The bridge
 * carries an error's name and message, not its class (`BridgeRequestError` copies the name onto itself), so a caller
 * that tests `instanceof StorageTransferError` needs the error rebuilt here.
 */
async function asTransferError<T>(request: Promise<T>): Promise<T> {
  try {
    return await request;
  } catch (error) {
    if (error instanceof BridgeRequestError && error.name === "StorageTransferError")
      throw new StorageTransferError(error.message);
    throw error;
  }
}

/** Whether a held record is the medium of an import: the same kind, type, and bytes. */
async function sameMedium(
  record: CapturedMediaRecord,
  medium: SessionTransferMedium,
): Promise<boolean> {
  if (record.kind !== medium.kind || record.mimeType !== medium.type) return false;
  if (record.size !== medium.bytes.length) return false;
  const bytes = new Uint8Array(await record.data.arrayBuffer());
  return bytes.every((byte, index) => byte === medium.bytes[index]);
}

/** A session to export, and how many references in it name no photo or file this browser holds. */
export interface SessionExport {
  readonly transfer: SessionTransfer;
  readonly missing: number;
}

/**
 * A session read for an import (`readTransfer`): its scope, title, saved values, photos and files, and events, while its
 * checkpoint and restored state stay in the host under `ticket`.
 */
export interface SessionTransferRead {
  readonly ticket: string;
  readonly scope: string;
  readonly name: string | null;
  readonly entries: readonly RuntimeScriptStorageEntrySnapshot[];
  readonly media: readonly SessionTransferMedium[];
  readonly events: readonly InterpreterEvent[];
}

/** What an exported file or text holds, as `readTransfer` read it: the saved data of scripts, or a session. */
export type PlayerTransferRead =
  | { readonly kind: "savedData"; readonly bundle: StorageBundle }
  | ({ readonly kind: "session" } & SessionTransferRead);

/** A checked session import, shown before the player confirms it. */
export interface SessionImportReview {
  readonly transfer: SessionTransferRead;
  readonly name: string | null;
  /** How many values the script has saved now, which the import replaces. */
  readonly currentValues: number;
}
