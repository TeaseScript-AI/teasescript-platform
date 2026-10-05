/**
 * Player notices: the one channel through which host-side features tell the player that something about the session's
 * environment matters, such as blocked audio or unavailable storage. Notices never stop the session. They are separate
 * from runtime `developerWarning` events, which are creator diagnostics about a script location.
 */
export type PlayerNoticeLevel = "info" | "warning" | "error";

export interface PlayerNotice {
  /** Identifies the condition; publishing the same key again replaces that notice instead of adding another. */
  readonly key: string;
  readonly level: PlayerNoticeLevel;
  readonly message: string;
  /** One control the player may activate, such as retrying audio; it runs from the player's click. */
  readonly action?: { readonly label: string; readonly run: () => void };
  /**
   * `false` for a notice whose action is the player's only way to recover, such as retrying blocked audio the script
   * waits for; its producer withdraws it once the condition resolves. Notices are dismissible otherwise.
   */
  readonly dismissible?: boolean;
}

export type PlayerNoticeListener = (notices: readonly PlayerNotice[]) => void;

/** The current notices in publication order. */
export class PlayerNotices {
  readonly #notices = new Map<string, PlayerNotice>();
  readonly #listeners = new Set<PlayerNoticeListener>();

  public get list(): readonly PlayerNotice[] {
    return [...this.#notices.values()];
  }

  public publish(notice: PlayerNotice): void {
    // A replaced notice keeps its place, so a repeated condition does not move to the end.
    this.#notices.set(notice.key, Object.freeze({ ...notice }));
    this.#notify();
  }

  /** Removes a notice, when its condition is resolved or the player dismisses it. */
  public dismiss(key: string): void {
    if (this.#notices.delete(key)) this.#notify();
  }

  public subscribe(listener: PlayerNoticeListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #notify(): void {
    const notices = this.list;
    for (const listener of this.#listeners) listener(notices);
  }
}

/** The keys of the conditions the Player reports, so a feature can dismiss its notice when it resolves. */
export const playerNoticeKeys = {
  audioBlocked: "audio-blocked",
  storageUnavailable: "storage-unavailable",
  storageWriteFailed: "storage-write-failed",
  imageNeedsCamera: "image-needs-camera",
} as const;

/**
 * The Player's fixed wording for each condition it reports. To report a new condition, add an entry here and publish it
 * from the feature that detects the condition.
 */
export const playerNotices = {
  audioBlocked: (retry: () => void): PlayerNotice => ({
    key: playerNoticeKeys.audioBlocked,
    level: "warning",
    message: "The browser blocked audio.",
    action: { label: "Enable audio", run: retry },
    dismissible: false,
  }),
  storageUnavailable: (): PlayerNotice => ({
    key: playerNoticeKeys.storageUnavailable,
    level: "info",
    message: "This browser does not keep saved progress, so the next run starts fresh.",
  }),
  storageWriteFailed: (): PlayerNotice => ({
    key: playerNoticeKeys.storageWriteFailed,
    level: "warning",
    message: "Some progress could not be saved in this browser.",
  }),
  imageNeedsCamera: (): PlayerNotice => ({
    key: playerNoticeKeys.imageNeedsCamera,
    level: "warning",
    message: "This image request needs a camera, which cannot be used here.",
  }),
} as const;
