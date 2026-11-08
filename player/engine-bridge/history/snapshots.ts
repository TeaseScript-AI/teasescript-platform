/**
 * Where Debug's rewind history keeps snapshots beyond memory (`player/debug-history-indexeddb.ts`). It lives only as
 * long as its history, which destroys it. Its methods take and return plain data.
 */
export interface DebugHistorySpill {
  put(id: number, json: string): Promise<void>;
  /** The JSON stored under `id`, or `undefined` when there is none. */
  get(id: number): Promise<string | undefined>;
  delete(ids: readonly number[]): Promise<void>;
  /** Closes the store and deletes everything in it. */
  destroy(): Promise<void>;
}

/**
 * UTF-16 code units of snapshot JSON the history holds in memory, pending spill writes included (docs/DEBUGGER.md
 * "Rewind"; `player.debug-history-admitted-snapshot-chars` in docs/RESOURCE-LIMITS.md). A snapshot that would exceed
 * it is not admitted.
 */
export const DEBUG_HISTORY_ADMITTED_SNAPSHOT_CHARS = 32 * 1024 * 1024;

/** How the store's spill stands: not opened yet, opening, written to, absent, or failed on a write. */
type SpillState = "closed" | "opening" | "writing" | "absent" | "failed";

/**
 * Snapshot JSON by position ID, written through to the spill, which opens at the first admission: each admitted
 * snapshot is written at once, and its memory copy is dropped only after its write completed. Memory therefore holds
 * the snapshots whose writes are pending, or, with no spill store, every snapshot. Admission counts both against `budget` and refuses a snapshot that would exceed
 * it; a spill write that fails reports through `failed`, and the store keeps what it holds.
 */
export class SnapshotStore {
  readonly #memory = new Map<number, string>();
  #memoryChars = 0;
  readonly #spilled = new Set<number>();
  readonly #open: () => Promise<DebugHistorySpill | null>;
  #spill: Promise<DebugHistorySpill | null> | null = null;
  #state: SpillState = "closed";
  #queue: Promise<void> = Promise.resolve();
  #destroyed = false;

  constructor(
    /** Opens the spill store, `null` where there is none; called once, at the first admission. */
    open: () => Promise<DebugHistorySpill | null>,
    readonly budget: number = DEBUG_HISTORY_ADMITTED_SNAPSHOT_CHARS,
    /** Called once when a spill write fails; the store takes no more snapshots into the spill. */
    readonly failed: () => void = () => {},
  ) {
    this.#open = open;
  }

  /** The spill store, opened on first use. */
  #opened(): Promise<DebugHistorySpill | null> {
    if (this.#spill !== null) return this.#spill;
    this.#state = "opening";
    this.#spill = Promise.resolve()
      .then(() => this.#open())
      .then(
        (store) => {
          if (this.#state === "opening") this.#state = store === null ? "absent" : "writing";
          return store;
        },
        () => {
          if (this.#state === "opening") this.#state = "absent";
          return null;
        },
      );
    return this.#spill;
  }

  /** The code units held in memory, pending writes included. */
  get memoryChars(): number {
    return this.#memoryChars;
  }
  get spilledCount(): number {
    return this.#spilled.size;
  }

  /**
   * Admits `json` under `id`, or refuses it when it would exceed the budget. An admitted snapshot is written through to
   * the spill when there is one.
   */
  add(id: number, json: string): boolean {
    if (this.#destroyed) return false;
    if (this.#memoryChars + json.length > this.budget) return false;
    this.#memory.set(id, json);
    this.#memoryChars += json.length;
    if (this.#state !== "absent" && this.#state !== "failed") this.#writeThrough(id, json);
    return true;
  }

  async get(id: number): Promise<string> {
    const kept = this.#memory.get(id);
    if (kept !== undefined) return kept;
    const spilled = this.#spilled.has(id) ? await (await this.#opened())?.get(id) : undefined;
    if (spilled === undefined) throw new Error("This state of the session is no longer available.");
    return spilled;
  }

  delete(ids: Iterable<number>) {
    const spilled: number[] = [];
    for (const id of ids) {
      this.#drop(id);
      if (this.#spilled.delete(id)) spilled.push(id);
    }
    if (spilled.length > 0)
      this.#queue = this.#queue.then(async () => {
        // A row that cannot be deleted now goes with the store.
        await (await this.#opened())?.delete(spilled).catch(() => {});
      });
  }

  async destroy() {
    this.#destroyed = true;
    this.#memory.clear();
    this.#memoryChars = 0;
    this.#spilled.clear();
    await this.#queue;
    // A store that never opened has nothing to delete.
    if (this.#spill !== null) await (await this.#spill)?.destroy().catch(() => {});
  }

  #drop(id: number) {
    const json = this.#memory.get(id);
    if (json === undefined) return;
    this.#memory.delete(id);
    this.#memoryChars -= json.length;
  }

  // Writes `json` to the spill, in order; once written, its memory copy goes, unless it was deleted or replaced meanwhile.
  #writeThrough(id: number, json: string) {
    this.#queue = this.#queue.then(async () => {
      const spill = await this.#opened();
      if (spill === null || this.#destroyed || this.#state === "failed") return;
      if (this.#memory.get(id) !== json) return;
      try {
        await spill.put(id, json);
      } catch {
        this.#state = "failed";
        this.failed();
        return;
      }
      // Deleted while it was being written, or the store destroyed: its row goes too.
      if (this.#destroyed || this.#memory.get(id) !== json) {
        await spill.delete([id]).catch(() => {});
        return;
      }
      this.#drop(id);
      this.#spilled.add(id);
    });
  }
}
