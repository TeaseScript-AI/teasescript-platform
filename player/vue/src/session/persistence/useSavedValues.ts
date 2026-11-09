import { computed, ref, shallowRef, watch, type Ref } from "vue";
import { tryOnScopeDispose } from "@vueuse/core";
import type { CapturedMediaStore } from "../../../../media/captured-media.js";
import { capturedMediaReferences } from "../../../../media/captured-media-persistence.js";
import { isWellFormedCapturedMediaReference } from "../../../../media/captured-media.js";
import type { PlayerRuntimeSessionOptions } from "../../../../runtime/runtime-adapter.js";
import { pendingPlayerRuntimeStorageWrite, type PlayerSession } from "../../../../runtime/runtime-view.js";
import { StaleOperation, type PersistenceOwnership } from "../../../../persistence/persistence-ownership.js";
import { BridgeRequestError } from "../../../../engine-bridge/client.js";
import { playerNoticeKeys, playerNotices, type PlayerNotices } from "../../../../presentation/notices.js";
import type { ScriptStorageProvider } from "../../../../persistence/script-storage.js";
import { RETIRED, type InputSectionHost } from "../runtime-input";
import { validateScriptStorageEntries } from "../../../../../src/runtime/host-data/script-storage.js";
import { serializableEquals } from "../../../../../src/runtime/values/serializable-values.js";
import type {
  RuntimeScriptStorageEntrySnapshot,
  SerializableRuntimeValue,
} from "../../../../../src/index.js";

/*
 * The script's saved values as the session composable keeps and edits them, moved from `usePlayerSession` unchanged: the
 * values read, the script's writes, Debug's edits, the clear, and the marks that saved data changes.
 */

/** What the saved values need from the Player's session composable. */
interface SavedValuesHost {
  /** The saved values in use, through the route (`useStorageRoute`). */
  readonly storageProvider: ScriptStorageProvider | undefined;
  readonly capturedMedia: CapturedMediaStore;
  readonly session: Readonly<Ref<PlayerSession | null>>;
  readonly generation: Readonly<Ref<number>>;
  readonly stopped: Readonly<Ref<boolean>>;
  readonly isDisposed: () => boolean;
  /** An input section of the shown session, read when used. */
  readonly inputSection: InputSectionHost;
  /** Ends Debug's rewind history, whose owner is made after this one. */
  readonly retireRewind: (by: "clear" | "import" | "loss") => void;
  /** The Player's notices, read when used. */
  readonly notices: () => PlayerNotices;
  /** Whether a restored state is inspected, read when used. */
  readonly inspecting: () => Readonly<Ref<boolean>>;
  /** The prepared Start or Continue, read when used. */
  readonly activation: () => Readonly<Ref<{ readonly kind: "start" | "continue" } | null>>;
  /** Whether a Start or Continue is beginning, read when used. */
  readonly beginning: () => Readonly<Ref<boolean>>;
}

export function useSavedValues({
  storageProvider,
  capturedMedia,
  session,
  generation,
  stopped,
  isDisposed,
  inputSection,
  retireRewind,
  notices,
  inspecting,
  activation,
  beginning,
}: SavedValuesHost) {
  // Every change this Player makes to the stored values goes through here, which keeps `storedEntries` equal to what the
  // provider holds as far as this Player knows, such as for the debug room's offer to delete them; another tab's
  // changes arrive with the next read. A failed change leaves them as they were; session-local values (`null`) stay
  // session-local.
  const scriptStorage: ScriptStorageProvider | undefined = storageProvider && {
    scope: storageProvider.scope,
    load: () => storageProvider.load(),
    write: (key, value) =>
      whenStored(storageProvider.write(key, value), () => noteStored(key, value)),
    replace: (entries) =>
      whenStored(storageProvider.replace(entries), () => {
        if (storedEntries.value !== null) storedEntries.value = [...entries];
      }),
    clear: () =>
      whenStored(storageProvider.clear(), () => {
        if (storedEntries.value !== null) storedEntries.value = [];
      }),
  };
  // Notes the change once the provider stored it, before its caller learns of it, and hands the caller the provider's
  // own promise, so the change settles for it exactly as it would without the note.
  function whenStored(change: Promise<void>, note: () => void): Promise<void> {
    change.then(note, () => {});
    return change;
  }
  // The stored values that seed the next session, or `null` when storage is session-local: no provider, or one that
  // could not load, such as a browser that denies storage. A session-local run plays normally and keeps nothing.
  const storedEntries = shallowRef<readonly RuntimeScriptStorageEntrySnapshot[] | null>(null);
  // The references in the stored values that the media store had stored when they were read: the stored files a Start
  // names, with those it holds since.
  let readStoredFiles: ReadonlySet<string> = new Set();
  // Counts changes this Player made to the saved values: a stored save, a clear, an import, or a fresh read.
  const savedDataRevision = ref(0);
  /**
   * Reads the stored values freshly; call it before the first `prepare`, so the start page knows them. Each Start reads
   * them again (`activate`).
   */
  async function loadScriptStorage(): Promise<void> {
    applyScriptStorage(await readScriptStorage(scriptStorage));
  }
  /**
   * The stored values read freshly, with the references among them the media store had stored, or `null` when storage
   * could not be read; `undefined` without storage. It changes nothing on the page: `applyScriptStorage` does. For the
   * persistence operation `owner`, `values` are its own (`operationStorage`) and every call is admitted; a refused one
   * rejects with `StaleOperation`.
   */
  async function readScriptStorage(
    values: ScriptStorageProvider | undefined,
    owner?: PersistenceOwnership,
  ): Promise<
    | {
        readonly entries: readonly RuntimeScriptStorageEntrySnapshot[];
        readonly storedFiles: ReadonlySet<string>;
      }
    | null
    | undefined
  > {
    if (values === undefined) return undefined;
    try {
      const entries = await values.load();
      const storedFiles = await capturedMedia
        .knownReferences(storedValueReferences(entries), owner)
        .catch(rejectedUnlessStale(new Set<string>()));
      return { entries, storedFiles };
    } catch (error) {
      if (error instanceof StaleOperation) throw error;
      return null;
    }
  }
  /** Shows what `readScriptStorage` read, at once. */
  function applyScriptStorage(read: Awaited<ReturnType<typeof readScriptStorage>>): void {
    if (read === undefined) return;
    if (read === null) {
      storedEntries.value = null;
      notices().publish(playerNotices.storageUnavailable());
      return;
    }
    readStoredFiles = read.storedFiles;
    storedEntries.value = read.entries;
    savedDataRevision.value++;
    notices().dismiss(playerNoticeKeys.storageUnavailable);
  }
  /**
   * Session options for the script's storage; call it from the Start factory. The references in the stored values that
   * the media store holds, or had stored when they were read, are stored files the session knows, so `toJson` writes
   * them and `fileToBase64` reads them; other text, also text of the same shape, stays text.
   */
  function scriptStorageOptions(): PlayerRuntimeSessionOptions {
    if (storedEntries.value === null) return {};
    const storedFiles = [...storedValueReferences(storedEntries.value)].filter(
      (reference) => readStoredFiles.has(reference) || capturedMedia.knows(reference),
    );
    return { scriptStorage: storedEntries.value, persistentScriptStorage: true, storedFiles };
  }
  // Each pending write is persisted once through the provider and then reported to the runtime, which keeps the
  // previous value when it failed (warning TSW014). Every published session is observed, whichever operation made it.
  // Keyed by session generation too: a newer session reuses action IDs.
  const writesInFlight = new Set<string>();
  // For each Debug edit being stored: the script writes stored meanwhile, by key, which then stand over the edit.
  const scriptWritesStored = new Set<Map<string, SerializableRuntimeValue>>();
  // A running or resumable session keeps its own view of the stored values, so clearing waits until it ends; while a
  // clear runs, no second clear and no Start can begin, so a new session never starts from the values being removed.
  const clearing = ref(false);
  // While an import replaces the saved data, no Start, Continue, or clear begins.
  const importing = ref(false);
  // Debug storage edits (DEBUGGER.md "Player Debug"), one at a time. An edit is stored first and reaches the running
  // session only once that succeeded, through the engine's storage-edit input; its next `load` then returns it. While
  // the script's own write waits for the host, an edit is not taken: it would have to come between that write and the
  // script. A write the script issues while an edit is being stored settles as usual first.
  let editChain: Promise<unknown>;
  /** Puts a stored value into `storedEntries`, as the provider now holds it; see `scriptStorage`. */
  function noteStored(key: string, value: SerializableRuntimeValue) {
    const entries = storedEntries.value;
    if (entries === null) return;
    const others = entries.filter((entry) => entry.key !== key);
    storedEntries.value = value === null ? others : [...others, { key, value }];
  }
  // Which session Debug changed the saved values of, for its debug export: when and how often, as the shown session's
  // marks say (the host counts each edit it applied).
  const debugEdits = computed(() => session.value?.marks.editedWhileDebugging ?? null);
  /** Whether a running or waiting session takes an edit now; one that waits for Continue or the camera does not. */
  const liveSession = () =>
    session.value !== null &&
    !stopped.value &&
    (session.value.state.status === "running" || session.value.state.status === "waiting") &&
    activation().value === null &&
    !beginning().value;
  /** Whether the running session's own write waits for the host, so it takes no edit until that settled. */
  const scriptSaving = () =>
    liveSession() && pendingPlayerRuntimeStorageWrite(session.value!.state) !== null;
  // Edits that wait for the session's write to settle; each published session or new run wakes them to look again.
  const writeSettledWaiters = new Set<() => void>();

  /**
   * Changes one saved value for Debug: `value: null` deletes the key. `expected` is the value the editor started from,
   * `undefined` for a new key; a saved value that changed meanwhile is reported, not overwritten. The edit is stored
   * first; a running session's next `load` then returns it, and values it already loaded keep what they loaded.
   */
  function editSavedData(edit: {
    readonly key: string;
    readonly value: SerializableRuntimeValue;
    readonly expected: SerializableRuntimeValue | undefined;
  }): Promise<SavedDataEditResult> {
    // The edit belongs to the session at hand when it was made; a later session, or an unmounted Player, never takes it.
    const owner = generation.value;
    const result = editChain.then(() => applySavedDataEdit(edit, owner));
    editChain = result.catch(() => undefined);
    // Debug's rewind waits until the edit is stored and the session took it.
    editsInFlight.value++;
    void editChain.then(() => editsInFlight.value--);
    return result;
  }
  async function applySavedDataEdit(
    {
      key,
      value,
      expected,
    }: {
      readonly key: string;
      readonly value: SerializableRuntimeValue;
      readonly expected: SerializableRuntimeValue | undefined;
    },
    owner: number,
  ): Promise<SavedDataEditResult> {
    const failed = (message: string) => ({ kind: "failed", message }) as const;
    const retired = () => isDisposed() || generation.value !== owner;
    const sessionChanged = () => failed("The session changed meanwhile; open the editor again.");
    if (retired()) return sessionChanged();
    if (!scriptStorage || storedEntries.value === null)
      return failed("This browser's saved data cannot be read.");
    if (
      importing.value ||
      clearing.value ||
      beginning().value ||
      inspecting().value ||
      activation().value?.kind === "continue"
    )
      return failed("Saved data cannot be changed right now.");
    if (scriptSaving()) return { kind: "busy" };
    if (value !== null) {
      const problem = validateScriptStorageEntries([{ key, value }], "value");
      if (problem !== null) return failed(problem);
    }
    let current: readonly RuntimeScriptStorageEntrySnapshot[];
    try {
      current = await scriptStorage.load();
    } catch {
      return failed("This browser's saved data cannot be read.");
    }
    if (retired()) return sessionChanged();
    const now = current.find((entry) => entry.key === key)?.value;
    if (!sameSavedValue(now, expected)) return { kind: "changed" };
    if (scriptSaving()) return { kind: "busy" };
    // A script write issued from here on is stored after the edit: the Player's providers store writes in the order
    // they were issued. Once those settled, a stored one of this key stands, in storage as in the session.
    const stored = new Map<string, SerializableRuntimeValue>();
    scriptWritesStored.add(stored);
    try {
      try {
        await scriptStorage.write(key, value);
      } catch {
        return failed("The change could not be saved in this browser. Nothing changed.");
      }
      savedDataRevision.value++;
      // The edit is stored once. It reaches the session once no script write is pending there, also one that became
      // pending while the edit waited for its section or after it was posted (`storageWritePending`): then it waits
      // for that write and tries again.
      for (;;) {
        while (
          !retired() &&
          !stopped.value &&
          session.value !== null &&
          pendingPlayerRuntimeStorageWrite(session.value.state) !== null
        )
          await new Promise<void>((resolve) => writeSettledWaiters.add(resolve));
        if (retired() || stopped.value) return { kind: "saved", live: false };
        if (stored.has(key)) return { kind: "overtaken" };
        if (!liveSession()) return { kind: "saved", live: false };
        const decided = await inputSection("storageEdit", async (section) => {
          // Rechecked at the section's turn: input before it may have published meanwhile.
          if (!section.owned() || retired()) return { kind: "saved", live: false } as const;
          if (stored.has(key)) return { kind: "overtaken" } as const;
          if (!liveSession()) return { kind: "saved", live: false } as const;
          if (pendingPlayerRuntimeStorageWrite(section.session.state) !== null) return "wait";
          let outcome: { readonly kind: string } | typeof RETIRED;
          try {
            outcome = await section.send<{ readonly kind: string }>("applyStorageEdit", {
              key,
              value,
            });
          } catch (error) {
            // Stored, the edit settles also when the bridge failed to carry it: what the engine threw is reported.
            if (error instanceof BridgeRequestError && error.kind === "engine") throw error;
            return { kind: "saved", live: false } as const;
          }
          if (outcome === RETIRED || !section.owned())
            return { kind: "saved", live: false } as const;
          if (outcome.kind === "storageWritePending") return "wait";
          if (outcome.kind !== "applied") return { kind: "saved", live: false } as const;
          return { kind: "saved", live: true } as const;
        });
        if (decided === null) return { kind: "saved", live: false };
        if (decided !== "wait") return decided;
        // A write the session issued meanwhile: wait for it outside the section, as above. Until the shown session
        // shows it, the next publication wakes the wait.
        if (
          session.value !== null &&
          pendingPlayerRuntimeStorageWrite(session.value.state) === null
        )
          await new Promise<void>((resolve) => writeSettledWaiters.add(resolve));
      }
    } finally {
      scriptWritesStored.delete(stored);
    }
  }
  const canClearScriptStorage = computed(
    () =>
      scriptStorage !== undefined &&
      storedEntries.value !== null &&
      !clearing.value &&
      !importing.value &&
      !beginning().value &&
      !inspecting().value &&
      activation().value?.kind !== "continue" &&
      (session.value === null ||
        session.value.state.status === "halted" ||
        session.value.state.status === "failed"),
  );
  /** Removes this script's saved data; resolves to whether it was cleared. */
  async function clearScriptStorage(): Promise<boolean> {
    if (!scriptStorage || !canClearScriptStorage.value) return false;
    clearing.value = true;
    try {
      await scriptStorage.clear();
      savedDataRevision.value++;
      // Debug's rewind could restore the saved data cleared now, so its history ends.
      retireRewind("clear");
      return true;
    } catch {
      return false;
    } finally {
      clearing.value = false;
    }
  }
  // The operation that set `importing` last, which alone clears it: a stale one never clears a newer one's.
  let importingHolder: object | null = null;
  /** Marks saved data as changing for the caller; the returned function clears the mark unless another took it. */
  function holdImporting(): () => void {
    const holder = {};
    importingHolder = holder;
    importing.value = true;
    return () => {
      if (importingHolder !== holder) return;
      importingHolder = null;
      importing.value = false;
    };
  }
  /** A fallback for a failed store call of a persistence operation, unless its handle refused the call as stale. */
  function rejectedUnlessStale<T>(fallback: T): (error: unknown) => T {
    return (error) => {
      if (error instanceof StaleOperation) throw error;
      return fallback;
    };
  }
  const editsInFlight = ref(0);

  return {
    scriptStorage,
    storedEntries,
    savedDataRevision,
    loadScriptStorage,
    readScriptStorage,
    applyScriptStorage,
    scriptStorageOptions,
    clearing,
    importing,
    debugEdits,
    liveSession,
    scriptSaving,
    editSavedData,
    canClearScriptStorage,
    clearScriptStorage,
    holdImporting,
    rejectedUnlessStale,
    editsInFlight,
    /**
     * Watches the script's writes and wakes the Debug edits that wait for one, from the place of the composable's
     * setup they had; the edit chain begins there too.
     */
    watchWrites() {
      watch(
        session,
        (current) => {
          const write = current && pendingPlayerRuntimeStorageWrite(current.state);
          // A stopped session issues no more writes, also when it is published again, such as by Debug's value trace.
          if (!scriptStorage || !write || stopped.value) return;
          const sessionGeneration = generation.value;
          const flight = `${sessionGeneration}:${write.actionId}`;
          if (writesInFlight.has(flight)) return;
          writesInFlight.add(flight);
          void scriptStorage.write(write.key, write.value).then(
            () => yieldThenReport(true),
            () => yieldThenReport(false),
          );
          // Continue in a later task: a script that saves in a loop must not starve input and rendering.
          function yieldThenReport(stored: boolean) {
            setTimeout(() => report(stored), 0);
          }
          function report(stored: boolean) {
            // The flight lasts until the acknowledgement applied or retired: a publication that still shows the pending
            // write meanwhile issues no second provider write.
            void acknowledge(stored).finally(() => writesInFlight.delete(flight));
          }
          async function acknowledge(stored: boolean) {
            // A write that settles after unmount must not continue the session.
            if (isDisposed()) return;
            const latest = session.value;
            // The report must belong to the session that requested it, which has not stopped.
            if (generation.value !== sessionGeneration || latest === null || stopped.value) return;
            if (pendingPlayerRuntimeStorageWrite(latest.state)?.actionId !== write!.actionId)
              return;
            if (!stored) notices().publish(playerNotices.storageWriteFailed());
            else {
              savedDataRevision.value++;
              for (const stored of scriptWritesStored) stored.set(write!.key, write!.value);
            }
            // The provider's write is made; the acknowledgement goes only to the session that still owns the UI, once.
            await inputSection("storageWriteDone", async (section) => {
              if (!section.owned() || generation.value !== sessionGeneration) return;
              await section.send("completeStorageWrite", { actionId: write!.actionId, stored });
            });
          }
        },
        { flush: "sync" },
      );
      editChain = Promise.resolve();
      // A stop wakes them too: the write they wait for is never acknowledged then.
      watch([session, generation, stopped], () => {
        for (const resolve of writeSettledWaiters) resolve();
        writeSettledWaiters.clear();
      });
      tryOnScopeDispose(() => {
        for (const resolve of writeSettledWaiters) resolve();
        writeSettledWaiters.clear();
      });
    },
  };
}

/** What a Debug storage edit did: saved (and taken by the running session when `live`), not saved, or overtaken. */
export type SavedDataEditResult =
  | { readonly kind: "saved"; readonly live: boolean }
  /** The running session's own write waits for the host; nothing was written. */
  | { readonly kind: "busy" }
  /** The script saved the same key after the edit was stored; its value stands, stored and in the session. */
  | { readonly kind: "overtaken" }
  /** The saved value changed since the editor read it; nothing was written. */
  | { readonly kind: "changed" }
  | { readonly kind: "failed"; readonly message: string };

/**
 * Whether two saved values are the same, as the script's `==` compares them; `undefined` is an absent key. A value too
 * large to write as text compares too.
 */
function sameSavedValue(
  left: SerializableRuntimeValue | undefined,
  right: SerializableRuntimeValue | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return serializableEquals(left, right);
}

/** The captured-media references of the stored values, by their shape: candidates that only the media store can confirm. */
export function storedValueReferences(
  entries: readonly RuntimeScriptStorageEntrySnapshot[],
): Set<string> {
  const references = new Set<string>();
  for (const entry of entries)
    for (const reference of capturedMediaReferences(entry.value))
      if (isWellFormedCapturedMediaReference(reference)) references.add(reference);
  return references;
}
