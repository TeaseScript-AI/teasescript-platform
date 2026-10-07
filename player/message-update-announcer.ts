/**
 * Polite announcements of changed messages (PLAYER-UI.md "Conversation"): a message that changes in place may be
 * offscreen or already read, so its new text is spoken from a status region, without moving focus. Changes are
 * coalesced per message, latest text first in line where the message first queued, and spoken one at a time: at most
 * one per `globalIntervalMs`, and the same message at most once per `messageIntervalMs`, so that one fast counter
 * cannot hold back another. A change that leaves the visible text as it was last shown or spoken is not spoken.
 * Framework-independent; the Player feeds it only changes that live play produced.
 */
export interface MessageUpdateAnnouncerOptions {
  readonly now: () => number;
  /** Runs `callback` after `delayMs`; the returned function cancels it. */
  readonly schedule: (callback: () => void, delayMs: number) => () => void;
  readonly announce: (text: string) => void;
  readonly globalIntervalMs?: number;
  readonly messageIntervalMs?: number;
}

interface PendingChange {
  speaker: string;
  text: string;
  /** The visible text the player last saw or heard before this change. */
  readonly before: string;
}

export class MessageUpdateAnnouncer {
  readonly #options: MessageUpdateAnnouncerOptions;
  readonly #globalIntervalMs: number;
  readonly #messageIntervalMs: number;
  // In first-change order; a later change of a queued message keeps its place.
  readonly #pending = new Map<number, PendingChange>();
  readonly #spokenAt = new Map<number, number>();
  #lastSpokenAt = Number.NEGATIVE_INFINITY;
  #scheduled: { readonly at: number; readonly cancel: () => void } | null = null;

  constructor(options: MessageUpdateAnnouncerOptions) {
    this.#options = options;
    this.#globalIntervalMs = options.globalIntervalMs ?? 1_000;
    this.#messageIntervalMs = options.messageIntervalMs ?? 5_000;
  }

  /** Message `messageId` of `speaker` changed from the visible text `before` to `text`. */
  update(messageId: number, speaker: string, before: string, text: string): void {
    const pending = this.#pending.get(messageId);
    if (pending === undefined) this.#pending.set(messageId, { speaker, text, before });
    else {
      pending.speaker = speaker;
      pending.text = text;
    }
    this.#plan();
  }

  /** Forgets every change and cancels the next announcement, as for a new session or a restored state. */
  reset(): void {
    this.#scheduled?.cancel();
    this.#scheduled = null;
    this.#pending.clear();
    this.#spokenAt.clear();
    this.#lastSpokenAt = Number.NEGATIVE_INFINITY;
  }

  #eligibleAt(messageId: number): number {
    return Math.max(
      this.#lastSpokenAt + this.#globalIntervalMs,
      (this.#spokenAt.get(messageId) ?? Number.NEGATIVE_INFINITY) + this.#messageIntervalMs,
    );
  }

  // Schedules the next announcement for the first moment a queued change may be spoken; a change that may be spoken
  // sooner than the one scheduled moves it earlier.
  #plan(): void {
    if (this.#pending.size === 0) return;
    let at = Number.POSITIVE_INFINITY;
    for (const messageId of this.#pending.keys()) at = Math.min(at, this.#eligibleAt(messageId));
    at = Math.max(at, this.#options.now());
    if (this.#scheduled !== null && this.#scheduled.at <= at) return;
    this.#scheduled?.cancel();
    this.#scheduled = {
      at,
      cancel: this.#options.schedule(() => {
        this.#scheduled = null;
        this.#flush();
      }, at - this.#options.now()),
    };
  }

  // Speaks the first queued change that may be spoken now, dropping those that changed nothing visible.
  #flush(): void {
    const now = this.#options.now();
    for (const [messageId, change] of this.#pending) {
      if (change.text === change.before) {
        this.#pending.delete(messageId);
        continue;
      }
      if (now < this.#eligibleAt(messageId)) continue;
      this.#pending.delete(messageId);
      this.#spokenAt.set(messageId, now);
      this.#lastSpokenAt = now;
      this.#options.announce(
        change.text === ""
          ? `${change.speaker}: message cleared`
          : `${change.speaker}: ${change.text}`,
      );
      break;
    }
    this.#plan();
  }
}
