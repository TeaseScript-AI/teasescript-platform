import type { InterpreterEvent } from "../src/runtime/events.js";
import type { Introduction, Publication } from "./engine-bridge/session-protocol.js";
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
 * `PublicationGapError`, never a silent merge. Once halted (a Player error stop), the store applies nothing more.
 */
export class SessionStore {
  readonly #id: string;
  readonly #connection: PlayerBridge;
  readonly #planToken: string;
  readonly #liveEventSequence: number;
  readonly #events: InterpreterEvent[] = [];
  readonly #entries: PlayerTranscriptEntryPresentation[] = [];
  readonly #rows = new Map<number, number>();
  readonly #removed: number[] = [];
  readonly #speakers: Record<string, PlayerSpeakerPresentation> = { ...DEFAULT_SPEAKERS };
  #transcriptRevision = 0;
  #cursor = 0;
  #halted = false;
  #session: PlayerSession;

  constructor(id: string, connection: PlayerBridge, introduction: Introduction) {
    this.#id = id;
    this.#connection = connection;
    this.#planToken = introduction.planToken;
    this.#liveEventSequence = introduction.liveEventSequence;
    this.#session = this.#append(introduction);
  }

  get session(): PlayerSession {
    return this.#session;
  }

  get halted(): boolean {
    return this.#halted;
  }

  /** Stops applying publications: what the host sends after a Player error stop is never shown. */
  halt(): void {
    this.#halted = true;
  }

  /**
   * Applies `view` when it is newer than the store's publication and continues its events, then hands the new session to
   * `publish`, in the same tick (a request's effects before Vue renders it). Returns whether it applied.
   */
  apply(view: Publication | null, publish?: (next: PlayerSession) => void): boolean {
    if (this.#halted || view === null || view.revision <= this.#session.revision) return false;
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
