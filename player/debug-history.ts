import type { InstructionPlan, InterpreterEvent } from "../src/index.js";
import type { DebugEditedWhileDebugging, DebugRewoundWhileDebugging } from "./debug-export.js";
import type {
  PlayerForegroundPresentation,
  PlayerSpeakerPresentation,
  PlayerTranscriptEntryPresentation,
} from "./model.js";
import {
  activePlayerRuntimeInteraction,
  playerRuntimeForeground,
  playerRuntimeSnapshotJson,
  playerRuntimeTranscript,
  type PlayerRuntimeSession,
} from "./runtime-adapter.js";

/**
 * Where Debug's rewind history keeps snapshots that no longer fit its memory budget (`debug-history-indexeddb.ts`). It
 * lives only as long as its history, which deletes it.
 */
export interface DebugHistorySpill {
  put(id: number, json: string): Promise<void>;
  /** The JSON stored under `id`, or `undefined` when there is none. */
  get(id: number): Promise<string | undefined>;
  delete(ids: readonly number[]): Promise<void>;
  /** Closes the store and deletes everything in it. */
  destroy(): Promise<void>;
}

/** The marks a session carries for a debug export, which travel with each state Debug restores. */
export interface DebugHistoryMarks {
  readonly editedWhileDebugging: DebugEditedWhileDebugging | null;
  readonly rewoundWhileDebugging: DebugRewoundWhileDebugging | null;
}

/** A state Debug can restore exactly: its snapshot, kept under `id`, and the events that led to it. */
export interface DebugHistoryPosition {
  readonly id: number;
  /** The session's event list; its first `eventCount` events led to this state and rebuild its transcript. */
  readonly events: readonly InterpreterEvent[];
  readonly eventCount: number;
  readonly sceneTimeMs: number;
  readonly marks: DebugHistoryMarks;
}

/** A rewind point: the state when an interaction was newly presented. */
export interface DebugHistoryPoint extends DebugHistoryPosition {
  readonly actionId: number;
  /** The interaction as it was presented. */
  readonly foreground: PlayerForegroundPresentation;
  /**
   * How the session answered it, once it did: the transcript row of the answer (`null` for a button that timed out)
   * and its text. After a rewind to this point, it is the earlier answer until the session answers again.
   */
  readonly response: DebugHistoryResponse | null;
}

export interface DebugHistoryResponse {
  readonly rowId: string | null;
  readonly text: string | null;
}

/** A position to restore, with its snapshot and the marks the restored session carries. */
export interface DebugHistoryRestore {
  readonly position: DebugHistoryPosition;
  readonly snapshotJson: string;
  readonly marks: DebugHistoryMarks;
}

/** The session being played, as Back parks it. */
export interface DebugHistoryCurrent {
  readonly session: PlayerRuntimeSession;
  readonly marks: DebugHistoryMarks;
}

/** Characters of snapshot JSON the history keeps in memory before it moves the oldest to its spill store. */
export const DEBUG_HISTORY_MEMORY_BUDGET = 32 * 1024 * 1024;

/**
 * Snapshot JSON by position ID: the newest in memory, up to the budget, and the rest in the spill store. A snapshot
 * leaves memory only once the spill store has it. Without a spill store, or after it failed, the history keeps what
 * fits in memory and takes no more.
 */
class SnapshotStore {
  readonly #memory = new Map<number, string>();
  #memoryChars = 0;
  readonly #spilled = new Set<number>();
  readonly #spill: Promise<DebugHistorySpill | null>;
  // Whether snapshots can leave memory: unknown while the spill store opens.
  #spillable: boolean | null = null;
  #queue: Promise<void> = Promise.resolve();
  #spilling = false;
  #destroyed = false;

  constructor(
    spill: Promise<DebugHistorySpill | null>,
    readonly budget: number,
  ) {
    this.#spill = spill.then(
      (store) => {
        this.#spillable = store !== null;
        return store;
      },
      () => {
        this.#spillable = false;
        return null;
      },
    );
  }

  get memoryChars(): number {
    return this.#memoryChars;
  }
  get spilledCount(): number {
    return this.#spilled.size;
  }

  /**
   * Keeps `json` under `id`; `false` when it does not fit and cannot be spilled. A `required` snapshot, such as the
   * state Back leaves, is always kept.
   */
  add(id: number, json: string, required = false): boolean {
    if (!required && this.#spillable === false && this.#memoryChars + json.length > this.budget)
      return false;
    this.#memory.set(id, json);
    this.#memoryChars += json.length;
    if (this.#memoryChars > this.budget) this.#spillOldest();
    return true;
  }

  async get(id: number): Promise<string> {
    const kept = this.#memory.get(id);
    if (kept !== undefined) return kept;
    const spilled = this.#spilled.has(id) ? await (await this.#spill)?.get(id) : undefined;
    if (spilled === undefined) throw new Error("This state of the session is no longer available.");
    return spilled;
  }

  delete(ids: Iterable<number>) {
    const spilled: number[] = [];
    for (const id of ids) {
      const json = this.#memory.get(id);
      if (json !== undefined) {
        this.#memory.delete(id);
        this.#memoryChars -= json.length;
      }
      if (this.#spilled.delete(id)) spilled.push(id);
    }
    if (spilled.length > 0)
      this.#queue = this.#queue.then(async () => {
        // A row that cannot be deleted now goes with the store.
        await (await this.#spill)?.delete(spilled).catch(() => {});
      });
  }

  async destroy() {
    this.#destroyed = true;
    this.#memory.clear();
    this.#memoryChars = 0;
    this.#spilled.clear();
    await this.#queue;
    await (await this.#spill)?.destroy().catch(() => {});
  }

  // Moves the oldest snapshots to the spill store, one at a time, until memory is within budget again.
  #spillOldest() {
    if (this.#spilling) return;
    this.#spilling = true;
    this.#queue = this.#queue.then(async () => {
      const spill = await this.#spill;
      while (spill !== null && !this.#destroyed && this.#memoryChars > this.budget) {
        const [id, json] = this.#memory.entries().next().value!;
        try {
          await spill.put(id, json);
        } catch {
          this.#spillable = false;
          break;
        }
        // Deleted while it was being written: its row goes too.
        if (this.#memory.get(id) !== json) await spill.delete([id]).catch(() => {});
        else {
          this.#memory.delete(id);
          this.#memoryChars -= json.length;
          this.#spilled.add(id);
        }
      }
      this.#spilling = false;
    });
  }
}

interface Inspection {
  /** The session as it was when Back first left it, which Return reinstates. */
  readonly parked: DebugHistoryCurrent;
  readonly parkedScanned: number;
  /** The state shown now, and how many points lead to it. */
  shown: DebugHistoryPosition;
  points: number;
  /** The states Forward returns to, the last first. */
  readonly forward: { readonly position: DebugHistoryPosition; readonly points: number }[];
}

/**
 * Debug's rewind history of one session (DEBUGGER.md "Rewind"): a point for every newly presented interaction, kept
 * until Debug is turned off or the session is replaced. Back restores a point and keeps the state it left for Forward;
 * the session it first left stays parked for Return until the player gives the restored state new input, which adopts
 * it as the session and discards the states after it. Framework-independent; the Player's session host applies the
 * states it returns.
 */
export class DebugHistory {
  readonly #store: SnapshotStore;
  #points: DebugHistoryPoint[] = [];
  #nextId = 1;
  // Action IDs grow along one session; a restored state counts again from its own, so IDs are unique only per line.
  #lastActionId = -1;
  // The sequence of the last event whose answer was looked for; restored states reuse sequences after their own.
  #scanned = -1;
  #inspection: Inspection | null = null;
  #complete = true;

  constructor(
    /** The plan of the session, which every state shares. */
    readonly plan: InstructionPlan,
    spill: Promise<DebugHistorySpill | null>,
    budget = DEBUG_HISTORY_MEMORY_BUDGET,
  ) {
    this.#store = new SnapshotStore(spill, budget);
  }

  /** The points that lead to the state shown, oldest first; while inspecting, the later ones too. */
  get points(): readonly DebugHistoryPoint[] {
    return this.#points;
  }

  /** While a restored state is shown: how many points lead to it, and whether Forward has a state. */
  get inspection(): { readonly points: number; readonly canForward: boolean } | null {
    const inspection = this.#inspection;
    return inspection === null
      ? null
      : { points: inspection.points, canForward: inspection.forward.length > 0 };
  }

  /** The state shown while inspecting, whose events after its own are the discarded-on-input future. */
  get shown(): DebugHistoryPosition | null {
    return this.#inspection?.shown ?? null;
  }

  /** The state Forward would restore, whose events after the shown state's are the grey future. */
  get future(): DebugHistoryPosition | null {
    return this.#inspection?.forward.at(-1)?.position ?? null;
  }

  /** `false` once a point did not fit in memory and could not be spilled; no later point is kept. */
  get complete(): boolean {
    return this.#complete;
  }

  get memoryChars(): number {
    return this.#store.memoryChars;
  }
  get spilledCount(): number {
    return this.#store.spilledCount;
  }

  /** Takes a published session in: links answers to their points and keeps a point for a new interaction. */
  follow(session: PlayerRuntimeSession, marks: DebugHistoryMarks) {
    if (this.#inspection !== null) return;
    this.#linkResponses(session.events);
    const interaction = activePlayerRuntimeInteraction(session.state);
    if (interaction === null || interaction.actionId <= this.#lastActionId || !this.#complete)
      return;
    const foreground = playerRuntimeForeground(session);
    if (foreground === null) return;
    const id = this.#nextId++;
    if (!this.#store.add(id, playerRuntimeSnapshotJson(session))) {
      this.#complete = false;
      return;
    }
    this.#lastActionId = interaction.actionId;
    this.#points = [
      ...this.#points,
      {
        ...this.#position(id, session, marks),
        actionId: interaction.actionId,
        foreground,
        response: null,
      },
    ];
  }

  /**
   * Restores the point at `index`, which must lead to the state shown; the state left stays for Forward. `current` gives
   * the session shown once the snapshot is read, which the first Back parks for Return; it gives `null` when the session
   * cannot be left now, and nothing changes.
   */
  async back(
    index: number,
    current: () => DebugHistoryCurrent | null,
  ): Promise<DebugHistoryRestore> {
    const point = this.#points[index];
    const inspection = this.#inspection;
    const leading = inspection?.points ?? this.#points.length;
    if (point === undefined || index >= leading || point === inspection?.shown)
      throw new RangeError("Back needs a point before the state shown.");
    const snapshotJson = await this.#store.get(point.id);
    if (this.#inspection !== inspection || this.#points[index] !== point)
      throw new Error("The history changed meanwhile.");
    const shown = current();
    if (shown === null) throw new Error("The session cannot go back now.");
    const left = inspection === null ? shown : inspection.parked;
    if (inspection === null) {
      const id = this.#nextId++;
      this.#store.add(id, playerRuntimeSnapshotJson(left.session), true);
      this.#inspection = {
        parked: left,
        parkedScanned: this.#scanned,
        shown: point,
        points: index + 1,
        forward: [{ position: this.#position(id, left.session, left.marks), points: leading }],
      };
    } else {
      inspection.forward.push({ position: inspection.shown, points: inspection.points });
      inspection.shown = point;
      inspection.points = index + 1;
    }
    return { position: point, snapshotJson, marks: this.#restoredMarks(point) };
  }

  /** Restores the state the last Back left, once it is read, if `ready` still holds then; otherwise nothing changes. */
  async forward(ready: () => boolean = () => true): Promise<DebugHistoryRestore> {
    const inspection = this.#inspection;
    const next = inspection?.forward.at(-1);
    if (inspection === null || next === undefined)
      throw new RangeError("Forward needs a state Back left.");
    const snapshotJson = await this.#store.get(next.position.id);
    if (this.#inspection !== inspection || inspection.forward.at(-1) !== next)
      throw new Error("The history changed meanwhile.");
    if (!ready()) throw new Error("The session cannot go forward now.");
    inspection.forward.pop();
    inspection.shown = next.position;
    inspection.points = next.points;
    return { position: next.position, snapshotJson, marks: this.#restoredMarks(next.position) };
  }

  /** Ends inspecting and returns the parked session to reinstate; the history is as it was before Back. */
  returnToSession(): DebugHistoryCurrent {
    const inspection = this.#inspection;
    if (inspection === null) throw new RangeError("Return needs a parked session.");
    this.#inspection = null;
    this.#scanned = inspection.parkedScanned;
    this.#store.delete(this.#unkeptIds(inspection, this.#points));
    return inspection.parked;
  }

  /**
   * Adopts the state shown as the session, once the player gives it new input: the parked session, the states Forward
   * had, and the points after the state shown are discarded.
   */
  adopt() {
    const inspection = this.#inspection;
    if (inspection === null) return;
    this.#inspection = null;
    const kept = this.#points.slice(0, inspection.points);
    this.#store.delete(this.#unkeptIds(inspection, kept));
    this.#points = kept;
    this.#lastActionId = Math.max(-1, ...kept.map((point) => point.actionId));
    const { shown } = inspection;
    this.#scanned = shown.events[shown.eventCount - 1]?.sequence ?? -1;
  }

  /** Deletes everything the history keeps. */
  async destroy() {
    this.#inspection = null;
    this.#points = [];
    await this.#store.destroy();
  }

  // A restored state keeps its storage-edit mark and counts as one more rewind of the session Back first left.
  #restoredMarks(position: DebugHistoryPosition): DebugHistoryMarks {
    const earlier = this.#inspection!.parked.marks.rewoundWhileDebugging?.rewindCount ?? 0;
    return {
      editedWhileDebugging: position.marks.editedWhileDebugging,
      rewoundWhileDebugging: {
        restoredSceneTimeMs: position.sceneTimeMs,
        rewindCount: earlier + 1,
      },
    };
  }

  #position(
    id: number,
    session: PlayerRuntimeSession,
    marks: DebugHistoryMarks,
  ): DebugHistoryPosition {
    return {
      id,
      events: session.events,
      eventCount: session.events.length,
      sceneTimeMs: session.state.observedSessionTimeMs,
      marks,
    };
  }

  // The IDs of positions the history no longer needs once only `kept` points remain.
  #unkeptIds(inspection: Inspection, kept: readonly DebugHistoryPoint[]): number[] {
    const keep = new Set(kept.map((point) => point.id));
    const ids = new Set([
      ...this.#points.map((point) => point.id),
      ...inspection.forward.map((state) => state.position.id),
      inspection.shown.id,
    ]);
    return [...ids].filter((id) => !keep.has(id));
  }

  // Records each newly settled interaction's answer on its point, by action ID, never by text.
  #linkResponses(events: readonly InterpreterEvent[]) {
    let first = events.length;
    while (first > 0 && events[first - 1]!.sequence > this.#scanned) first -= 1;
    for (let index = first; index < events.length; index += 1) {
      const event = events[index]!;
      this.#scanned = event.sequence;
      if (event.kind !== "actionCompleted" || event.settlement.actionKind !== "interaction")
        continue;
      const { actionId, transcriptEventSequence, transcriptText } = event.settlement;
      let at = this.#points.length - 1;
      while (at >= 0 && this.#points[at]!.actionId !== actionId) at -= 1;
      if (at === -1) continue;
      const response = {
        rowId: transcriptEventSequence === null ? null : `runtime-event-${transcriptEventSequence}`,
        text: transcriptText,
      };
      const points = [...this.#points];
      points[at] = { ...points[at]!, response };
      this.#points = points;
    }
  }
}

/**
 * The grey future of Debug's rewind (DEBUGGER.md "Rewind"): the messages of `future`, the state Forward restores, that
 * the inspected state `shown` has not reached, with the speakers they name. Both are states of one session, so the
 * shown state's events are the first of the future's. Each entry is marked `future` and keyed apart from the session's
 * own, which may reuse its sequence once new input adopts the shown state.
 */
export function rewindFutureTranscript(
  shown: DebugHistoryPosition,
  future: DebugHistoryPosition,
): {
  readonly entries: readonly PlayerTranscriptEntryPresentation[];
  readonly speakers: Readonly<Record<string, PlayerSpeakerPresentation>>;
} {
  const reached = playerRuntimeTranscript(shown.events.slice(0, shown.eventCount)).entries.length;
  const later = playerRuntimeTranscript(future.events.slice(0, future.eventCount));
  return {
    entries: later.entries
      .slice(reached)
      .map((entry) =>
        Object.freeze(
          entry.kind === "message"
            ? { ...entry, id: `future-${entry.id}`, future: true as const }
            : { ...entry, id: `future-${entry.id}` },
        ),
      ),
    speakers: later.speakers,
  };
}
