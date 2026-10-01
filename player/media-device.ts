import type {
  MediaLoadReport,
  MediaPlaybackProjection,
  MediaProgressReport,
} from "../src/index.js";

/** The browser media element surface the device uses; `HTMLAudioElement` satisfies it. */
export interface MediaDeviceElement {
  src: string;
  preload: string;
  volume: number;
  currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  readonly ended: boolean;
  play(): Promise<void>;
  pause(): void;
  load(): void;
  removeAttribute(name: "src"): void;
  addEventListener(type: "loadedmetadata" | "error" | "seeked" | "ended", listener: () => void): void;
}

export interface MediaDeviceHost {
  createElement(): MediaDeviceElement;
  /** Maps an authored, package-relative media reference to a playable URL, or `null` when it is not available. */
  resolveSource(source: string): string | null;
  /** Forwards a load report to the runtime; the device sends at most one per media instance. */
  reportLoad(mediaId: number, report: MediaLoadReport): void;
  /** Asks for a prompt time observation, for example after a range end. */
  requestObservation(): void;
  /** Called whenever the browser refuses or allows audible playback for any instance. */
  blockedChanged(blocked: boolean): void;
}

export const VIDEO_UNSUPPORTED_MESSAGE = "Video playback is not supported by this Player yet.";
export const SOURCE_UNAVAILABLE_MESSAGE = "This media source is not available to the Player.";
const LOAD_FAILED_MESSAGE = "The Player could not load this media source.";

interface Entry {
  readonly mediaId: number;
  readonly element: MediaDeviceElement | null;
  projection: MediaPlaybackProjection;
  /** The segment the element is positioned for; `null` until the first loaded projection is applied. */
  segment: number | null;
  /** Natural playback distance within `segment`, excluding stalls, pauses and seek jumps. */
  progressMs: number;
  /** Source position at the last measurement; `null` while a reposition is pending. */
  lastPositionMs: number | null;
  /** Source position to apply once metadata is available. */
  pendingPositionMs: number | null;
  metadata: boolean;
  loadReported: boolean;
  failed: boolean;
  blocked: boolean;
  finished: boolean;
}

/**
 * Plays the runtime's media projection on browser elements and measures what was actually played. The runtime owns
 * lifecycle, cues, segments and settlement; the device applies the projected state, reports loading once per
 * instance, and reports natural progress so cues never run ahead of what was heard.
 */
export class MediaDevice {
  readonly #host: MediaDeviceHost;
  readonly #entries = new Map<number, Entry>();
  #blocked = false;

  constructor(host: MediaDeviceHost) {
    this.#host = host;
  }

  /** Applies the latest projection: creates, loads, positions, plays, pauses and removes elements. */
  reconcile(media: readonly MediaPlaybackProjection[]): void {
    const present = new Set<number>();
    for (const projection of media) {
      present.add(projection.mediaId);
      const entry = this.#entries.get(projection.mediaId) ?? this.#create(projection);
      entry.projection = projection;
      this.#apply(entry);
    }
    for (const [mediaId, entry] of this.#entries) {
      if (!present.has(mediaId)) this.#remove(entry);
    }
    this.#updateBlocked();
  }

  /** Measures every running loaded instance; include the result in each time observation. */
  sample(): readonly MediaProgressReport[] {
    const reports: MediaProgressReport[] = [];
    for (const entry of this.#entries.values()) {
      const { projection } = entry;
      if (!projection.loaded || projection.state !== "running" || entry.segment !== projection.segment) continue;
      if (entry.element !== null && !entry.failed) this.#measure(entry, entry.element);
      reports.push({ mediaId: entry.mediaId, segment: entry.segment, progressMs: entry.progressMs });
    }
    return reports;
  }

  /** Whether any instance is waiting for load or running, so observations should continue regularly. */
  get active(): boolean {
    for (const entry of this.#entries.values()) {
      if (!entry.failed && (!entry.projection.loaded || entry.projection.state === "running")) return true;
    }
    return false;
  }

  get blocked(): boolean {
    return this.#blocked;
  }

  /** Retries refused playback; call from a user activation such as a click. */
  retryBlocked(): void {
    for (const entry of this.#entries.values()) {
      if (entry.blocked && entry.element !== null) this.#play(entry, entry.element);
    }
  }

  /** Stops and releases every element, for example before another session starts. */
  reset(): void {
    for (const entry of this.#entries.values()) this.#remove(entry);
    this.#updateBlocked();
  }

  #create(projection: MediaPlaybackProjection): Entry {
    const url = projection.media === "video" ? null : this.#host.resolveSource(projection.source);
    const entry: Entry = {
      mediaId: projection.mediaId,
      element: url === null ? null : this.#host.createElement(),
      projection,
      segment: null,
      progressMs: 0,
      lastPositionMs: null,
      pendingPositionMs: null,
      metadata: false,
      loadReported: false,
      failed: false,
      blocked: false,
      finished: false,
    };
    this.#entries.set(projection.mediaId, entry);
    if (entry.element === null) {
      entry.failed = true;
      this.#reportLoad(entry, {
        kind: "failed",
        message: projection.media === "video" ? VIDEO_UNSUPPORTED_MESSAGE : SOURCE_UNAVAILABLE_MESSAGE,
      });
      return entry;
    }
    const element = entry.element;
    element.addEventListener("loadedmetadata", () => this.#loadedMetadata(entry, element));
    element.addEventListener("error", () => {
      if (this.#entries.get(entry.mediaId) !== entry) return;
      // Before loading this is the canonical failure; after it no protocol exists, so progress simply stalls.
      entry.failed = true;
      element.pause();
      if (!entry.projection.loaded) this.#reportLoad(entry, { kind: "failed", message: LOAD_FAILED_MESSAGE });
    });
    element.addEventListener("seeked", () => {
      if (entry.pendingPositionMs === null) entry.lastPositionMs = element.currentTime * 1000;
    });
    element.addEventListener("ended", () => this.#host.requestObservation());
    element.preload = "auto";
    element.src = url ?? "";
    return entry;
  }

  #loadedMetadata(entry: Entry, element: MediaDeviceElement): void {
    if (this.#entries.get(entry.mediaId) !== entry) return;
    entry.metadata = true;
    if (!entry.projection.loaded) {
      const durationMs = element.duration * 1000;
      this.#reportLoad(
        entry,
        Number.isFinite(durationMs) && durationMs >= 0
          ? { kind: "loaded", durationMs }
          : { kind: "failed", message: LOAD_FAILED_MESSAGE },
      );
      return;
    }
    this.#apply(entry);
  }

  #reportLoad(entry: Entry, report: MediaLoadReport): void {
    if (entry.loadReported) return;
    entry.loadReported = true;
    this.#host.reportLoad(entry.mediaId, report);
  }

  #apply(entry: Entry): void {
    const { element, projection } = entry;
    if (element === null || entry.failed || !projection.loaded) return;
    element.volume = Math.min(1, Math.max(0, projection.volume));
    if (entry.segment !== projection.segment) {
      // The first applied segment continues from the runtime's saved progress: zero for new media, the checkpoint
      // value after a restore. Every later segment starts from zero.
      entry.progressMs = entry.segment === null ? projection.reportedProgressMs : 0;
      entry.segment = projection.segment;
      entry.finished = false;
      entry.pendingPositionMs = projection.playheadMs;
      entry.lastPositionMs = null;
    }
    if (!entry.metadata) return;
    if (entry.pendingPositionMs !== null) {
      const positionMs = entry.pendingPositionMs;
      entry.pendingPositionMs = null;
      this.#position(entry, element, positionMs);
    }
    if (projection.state === "running" && !entry.finished) {
      // A refused element waits for a deliberate retry instead of being asked again on every update.
      if (element.paused && !entry.blocked) this.#play(entry, element);
    } else if (!element.paused) {
      element.pause();
    }
  }

  #position(entry: Entry, element: MediaDeviceElement, positionMs: number): void {
    // Measure again from the browser's actual position once the seek completes.
    entry.lastPositionMs = null;
    element.currentTime = positionMs / 1000;
    if (Math.abs(element.currentTime * 1000 - positionMs) < 1) entry.lastPositionMs = positionMs;
  }

  #measure(entry: Entry, element: MediaDeviceElement): void {
    const { projection } = entry;
    if (entry.lastPositionMs === null || entry.finished || !entry.metadata) return;
    const positionMs = element.currentTime * 1000;
    const endMs = projection.endMs ?? element.duration * 1000;
    if (element.ended || positionMs >= endMs) {
      entry.progressMs += Math.max(0, endMs - entry.lastPositionMs);
      if (!this.#reachedTerminal(entry, element)) {
        // Repeat within the requested range; the runtime counts passes from the cumulative progress.
        this.#position(entry, element, projection.startAtMs);
        if (element.paused) this.#play(entry, element);
      }
      return;
    }
    if (positionMs >= entry.lastPositionMs) entry.progressMs += positionMs - entry.lastPositionMs;
    entry.lastPositionMs = positionMs;
    this.#reachedTerminal(entry, element);
  }

  #reachedTerminal(entry: Entry, element: MediaDeviceElement): boolean {
    const terminal = entry.projection.terminalProgressMs;
    if (terminal === null || entry.progressMs < terminal) return false;
    // The runtime settles playback from this report; stop audible output at the projected end.
    entry.progressMs = terminal;
    entry.finished = true;
    element.pause();
    return true;
  }

  #play(entry: Entry, element: MediaDeviceElement): void {
    element.play().then(
      () => {
        if (!entry.blocked) return;
        entry.blocked = false;
        this.#updateBlocked();
      },
      (error: unknown) => {
        // Never mute to get around a refusal: report no progress and offer a deliberate retry instead.
        if (error instanceof Error && error.name === "NotAllowedError" && this.#entries.get(entry.mediaId) === entry) {
          entry.blocked = true;
          this.#updateBlocked();
        }
      },
    );
  }

  #remove(entry: Entry): void {
    this.#entries.delete(entry.mediaId);
    const { element } = entry;
    if (element === null) return;
    element.pause();
    element.removeAttribute("src");
    element.load();
  }

  #updateBlocked(): void {
    let blocked = false;
    for (const entry of this.#entries.values()) blocked ||= entry.blocked;
    if (blocked === this.#blocked) return;
    this.#blocked = blocked;
    this.#host.blockedChanged(blocked);
  }
}
