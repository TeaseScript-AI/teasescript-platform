import type { InterpreterEvent } from "../../src/index.js";
import type {
  HistoryDelta,
  HistoryPosition,
  HistoryTimeline,
} from "../engine-bridge/history/core.js";
import type { PlayerSpeakerPresentation, PlayerTranscriptEntryPresentation } from "../presentation/model.js";
import { playerRuntimeTranscript } from "../runtime/runtime-view.js";

/**
 * The main side's view of the host's rewind history (`player/engine-bridge/history/`): its timeline, as `historyOpen`
 * or a resync sent it and as the deltas since changed it, and the event logs its positions name.
 *
 * A delta applies only when it is the open history's and enrollment's and continues the view's revision; any other is
 * discarded and the whole timeline read again (`resync`). A resync of another history, or older than the view, is
 * discarded too. A log is the events the main side received for one lineage (its session store's), taken from
 * `logOf` when a position first names it and retired once no point, shown or future position names it.
 */
export class DebugHistoryView {
  #timeline: HistoryTimeline;
  readonly #logs = new Map<string, readonly InterpreterEvent[]>();
  #resyncing = false;
  // A change discarded while a read was out, which that read may predate: the view reads again after it.
  #dirty = false;
  #closed = false;

  constructor(
    timeline: HistoryTimeline,
    private readonly logOf: (key: string) => readonly InterpreterEvent[] | null,
    private readonly resync: (history: number) => Promise<HistoryTimeline | null>,
    private readonly changed: (view: DebugHistoryView) => void = () => {},
  ) {
    this.#timeline = timeline;
    this.#retainLogs();
  }

  get timeline(): HistoryTimeline {
    return this.#timeline;
  }

  /** Whether the host's history ended (a resync found none); the view stays as it was, read-only. */
  get closed(): boolean {
    return this.#closed;
  }

  /** The lineage keys whose logs the view holds. */
  get logKeys(): readonly string[] {
    return [...this.#logs.keys()];
  }

  /** The events up to `position`'s boundary, or `null` when its log is not held. */
  eventsAt(position: HistoryPosition): readonly InterpreterEvent[] | null {
    return this.#logs.get(position.log)?.slice(0, position.eventCount) ?? null;
  }

  /** Applies each of `deltas` in order (`apply`). */
  applyAll(deltas: readonly HistoryDelta[]): void {
    for (const delta of deltas) this.apply(delta);
  }

  /** Applies `delta` when it continues the view; otherwise discards it and resyncs. Returns whether it applied. */
  apply(delta: HistoryDelta): boolean {
    const current = this.#timeline;
    if (
      this.#closed ||
      delta.history !== current.history ||
      delta.enrollment !== current.enrollment
    ) {
      if (!this.#closed) this.readAgain();
      return false;
    }
    if (delta.from !== current.revision || delta.to <= delta.from) {
      this.readAgain();
      return false;
    }
    let points = delta.retained === null ? current.points : current.points.slice(0, delta.retained);
    points = [...points, ...delta.appended];
    for (const { point, response } of delta.responses)
      points = points.map((each) =>
        each.id === point ? Object.freeze({ ...each, response }) : each,
      );
    this.#replace({
      history: current.history,
      enrollment: current.enrollment,
      revision: delta.to,
      points: Object.freeze(points),
      inspection: delta.inspection,
      complete: delta.complete,
      memoryChars: delta.memoryChars,
      spilledCount: delta.spilledCount,
    });
    return true;
  }

  /** Takes `timeline`, a whole timeline read again, unless it is another history's or older than the view. */
  take(timeline: HistoryTimeline | null): boolean {
    const current = this.#timeline;
    if (this.#closed) return false;
    if (timeline === null) {
      this.#closed = true;
      this.changed(this);
      return false;
    }
    if (
      timeline.history !== current.history ||
      timeline.enrollment !== current.enrollment ||
      timeline.revision < current.revision
    )
      return false;
    this.#replace(timeline);
    return true;
  }

  /** Ends the view where the host's history is gone (a lost connection): it stays as it was, read-only. */
  close(): void {
    this.#closed = true;
  }

  #replace(timeline: HistoryTimeline): void {
    this.#timeline = timeline;
    this.#retainLogs();
    this.changed(this);
  }

  /** Holds the log of each lineage a position names, and retires every other. */
  #retainLogs(): void {
    const { points, inspection } = this.#timeline;
    const named = new Set(points.map((point) => point.log));
    if (inspection !== null) {
      named.add(inspection.shown.log);
      if (inspection.future !== null) named.add(inspection.future.log);
    }
    for (const key of named)
      if (!this.#logs.has(key)) {
        const log = this.logOf(key);
        if (log !== null) this.#logs.set(key, log);
      }
    for (const key of this.#logs.keys()) if (!named.has(key)) this.#logs.delete(key);
  }

  /** Reads the whole timeline again (`resync`), once at a time; a reply older than the view is discarded. */
  readAgain(): void {
    if (this.#closed) return;
    if (this.#resyncing) {
      this.#dirty = true;
      return;
    }
    this.#resyncing = true;
    this.#dirty = false;
    const { history } = this.#timeline;
    // A failed read leaves the view as it is; the chain ends in a `catch`, so nothing rejects unhandled.
    void this.resync(history)
      .then((timeline) => this.take(timeline))
      .catch(() => false)
      .then(() => {
        this.#resyncing = false;
        if (this.#dirty) this.readAgain();
      });
  }
}

/**
 * The grey future of Debug's rewind (DEBUGGER.md "Rewind") for `view`'s inspection: the messages of the state Forward
 * restores that the shown state has not reached (`transcriptAfter`). Both are on one branch, so the shown state's
 * events are the first of the future's. `null` when no state with a future is shown, or a log it needs is not held.
 */
export function rewindFutureOf(view: DebugHistoryView): ReturnType<typeof transcriptAfter> | null {
  const inspection = view.timeline.inspection;
  if (inspection === null || inspection.future === null) return null;
  const shown = view.eventsAt(inspection.shown);
  const future = view.eventsAt(inspection.future);
  return shown === null || future === null ? null : transcriptAfter(shown, future);
}

/**
 * The messages of `future`'s events that `shown`'s have not reached, with the speakers they name; `shown`'s events
 * are the first of `future`'s. Each entry is marked `future` and keyed apart from the session's own, which may reuse
 * its sequence once new input adopts the shown state.
 */
function transcriptAfter(
  shown: readonly InterpreterEvent[],
  future: readonly InterpreterEvent[],
): {
  readonly entries: readonly PlayerTranscriptEntryPresentation[];
  readonly speakers: Readonly<Record<string, PlayerSpeakerPresentation>>;
} {
  const reached = playerRuntimeTranscript(shown).entries.length;
  const later = playerRuntimeTranscript(future);
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
