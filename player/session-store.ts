import type { InterpreterEvent } from "../src/runtime/events.js";
import type { CallViewReply, Introduction, Publication } from "./engine-bridge/session-protocol.js";
import type { PlayerSpeakerPresentation, PlayerTranscriptEntryPresentation } from "./model.js";
import type { PlayerBridge } from "./player-bridge.js";
import { appendTranscript, DEFAULT_SPEAKERS, type PlayerSession } from "./runtime-view.js";

/** A publication the store cannot apply: its events do not continue the ones it holds. */
export class PublicationGapError extends Error {
  override readonly name = "PublicationGapError";
}

/**
 * The main side's copy of one session: its latest publication, and the events, transcript and speakers its publications
 * accumulated, built with the same `appendTranscript` the engine's adapter uses. A publication's identity is its
 * revision: an older or repeated one is dropped. A newer one must continue the store's event cursor, or it is a
 * `PublicationGapError`, never a silent merge. At a Player error stop it applies the replies to ops the host ran before
 * the stop, until the host's acknowledgement, and then nothing more.
 */
export class SessionStore {
  readonly #id: string;
  readonly #connection: PlayerBridge;
  readonly #planToken: string;
  readonly #liveEventSequence: number;
  readonly #historyKey: string;
  readonly #events: InterpreterEvent[] = [];
  readonly #entries: PlayerTranscriptEntryPresentation[] = [];
  readonly #rows = new Map<number, number>();
  readonly #removed: number[] = [];
  readonly #speakers: Record<string, PlayerSpeakerPresentation> = { ...DEFAULT_SPEAKERS };
  #transcriptRevision = 0;
  #cursor = 0;
  /** `live`; `stopping` from a Player error stop until the host acknowledged it; then `frozen`. */
  #phase: "live" | "stopping" | "frozen" = "live";
  #session: PlayerSession;

  constructor(id: string, connection: PlayerBridge, introduction: Introduction) {
    this.#id = id;
    this.#connection = connection;
    this.#planToken = introduction.planToken;
    this.#liveEventSequence = introduction.liveEventSequence;
    this.#historyKey = introduction.historyKey;
    this.#session = this.#append(introduction);
  }

  get session(): PlayerSession {
    return this.#session;
  }

  /** Whether the store froze at a Player error stop: it applies nothing more. */
  get halted(): boolean {
    return this.#phase === "frozen";
  }

  /**
   * A Player error stop began: the store still applies the replies to ops the host ran before it, which arrive before
   * the host's acknowledgement, and freezes at that acknowledgement (`freeze`).
   */
  stopping(): void {
    if (this.#phase === "live") this.#phase = "stopping";
  }

  /**
   * Applies nothing more: what is shown is what the host ran before the stop, with the call view `final` of the
   * acknowledgement when it is of that publication (`mergeCallView`).
   */
  freeze(final: CallViewReply | null = null): void {
    if (this.#phase === "frozen") return;
    if (final !== null) this.mergeCallView(final);
    this.#phase = "frozen";
  }

  /**
   * Merges `reply` into the store's publication of the same revision, as a new session of that revision with its
   * instruction facts and call view: its state, events and transcript are the publication's. A reply of another
   * revision is dropped, and so is any reply once the store froze. Returns the merged session, or `null`.
   */
  mergeCallView(reply: CallViewReply): PlayerSession | null {
    if (this.halted || reply.revision !== this.#session.revision) return null;
    this.#session = Object.freeze({
      ...this.#session,
      instructions: reply.instructions,
      callView: reply.callView,
    });
    return this.#session;
  }

  /**
   * Applies `view` when it is newer than the store's publication and continues its events, then hands the new session to
   * `publish`, in the same tick (a request's effects before Vue renders it). Returns whether it applied.
   */
  apply(view: Publication | null, publish?: (next: PlayerSession) => void): boolean {
    if (this.halted || view === null || view.revision <= this.#session.revision) return false;
    if (view.from !== this.#cursor)
      throw new PublicationGapError(
        `A publication of events from ${view.from} does not continue the ${this.#cursor} held.`,
      );
    this.#session = this.#append(view);
    const next = this.#session;
    publish?.(next);
    return true;
  }

  #append(view: Publication): PlayerSession {
    if (view.events.length > 0) {
      for (const event of view.events) this.#events.push(event);
      appendTranscript(this.#entries, this.#rows, this.#removed, this.#speakers, view.events);
      this.#transcriptRevision += 1;
    }
    this.#cursor = view.eventsThrough;
    return Object.freeze({
      id: this.#id,
      connection: this.#connection,
      planToken: this.#planToken,
      lineage: this,
      revision: view.revision,
      state: Object.freeze(view.state),
      instructions: view.instructions,
      callView: view.callView,
      marks: view.marks,
      history: view.history,
      historyKey: this.#historyKey,
      liveEventSequence: this.#liveEventSequence,
      events: this.#events,
      transcriptEntries: this.#entries,
      transcriptMessageRows: this.#rows,
      transcriptRemovedRows: this.#removed,
      transcriptRevision: this.#transcriptRevision,
      speakers: this.#speakers,
    });
  }
}
