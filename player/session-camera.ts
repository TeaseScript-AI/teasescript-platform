import type { CapturedMediaAdmission, CaptureUnavailableReason } from "../src/index.js";
import type {
  AcquireOutcome,
  CaptureDevice,
  CaptureDeviceInfo,
  CaptureFailure,
  CaptureFailureKind,
  CaptureRequest,
  CaptureTrack,
} from "./capture-device.js";
import {
  activePlayerRuntimeCapture,
  answerPlayerRuntimeCapture,
  type PlayerCaptureAnswer,
  type PlayerRuntimeSession,
} from "./runtime-adapter.js";

/** A bounded Player diagnostic for developers; never shown as an ordinary Player notice. */
export interface PlayerDiagnostic {
  readonly code: string;
  readonly message: string;
}

const REASONS: Readonly<Record<CaptureFailureKind, CaptureUnavailableReason>> = {
  denied: "denied",
  "not-found": "notFound",
  overconstrained: "notFound",
  busy: "busy",
  unsupported: "unsupported",
  inactive: "revoked",
  failed: "failed",
};

/** How long a muted camera may deliver no frames while the page is shown before it opens again. */
const MUTE_GRACE_MS = 2_000;
/** The waits before the attempts of one recovery; a camera that cannot be opened by the last stays unavailable. */
const RECOVERY_DELAYS_MS = [0, 1_000, 3_000];
/** Trouble that comes back within this time of the last recovery continues the same run. */
const RECOVERY_SPACING_MS = 60_000;
/** The recoveries of one run of trouble; trouble after them stops the recoveries until the page is shown again. */
const RECOVERIES = 3;

export interface SessionCameraOptions {
  /** The camera the player chose in this browser, or `null` for the browser's default camera. */
  readonly chosen?: () => string | null;
  /** Whether the page is shown; a hidden page cannot get the camera back, so a recovery waits until it is shown. */
  readonly visible?: () => boolean;
  /** Waits the given milliseconds, between attempts to open the camera again. */
  readonly wait?: (milliseconds: number) => Promise<void>;
  /** Monotonic milliseconds, to tell trouble that keeps coming back. */
  readonly now?: () => number;
}

/**
 * The session camera: opened once when the session starts, kept open while it runs, and used silently by
 * `takePhoto()`. The player may switch it to another camera. A stream that the browser or the system ended or stopped
 * feeding, as when another app took the camera while the page was in the background, opens again by itself with the
 * same choice of camera, a few times at most; a capture waits for that rather than capturing a dead picture, and starts
 * it itself when it finds the stream dead first. Any other failure, a refusal, or a camera that cannot be opened again
 * leaves it unavailable for the rest of the session, so later captures answer `null` without opening the camera again
 * or asking for permission again.
 */
export class SessionCamera<Track extends CaptureTrack> {
  readonly #device: CaptureDevice<Track>;
  readonly #diagnostic: (diagnostic: PlayerDiagnostic) => void;
  readonly #chosen: () => string | null;
  readonly #visible: () => boolean;
  readonly #wait: (milliseconds: number) => Promise<void>;
  readonly #now: () => number;
  #unavailable: CaptureUnavailableReason | null = "unconfigured";
  /** Increments when the session camera is released, so late results of an earlier session are ignored. */
  #generation = 0;
  /** A switch to another camera until it settled. */
  #switching: Promise<boolean> | null = null;
  /** The camera opening again after its stream ended or stopped, until it settled. */
  #recovering: Promise<void> | null = null;
  /** The recoveries of the current run of trouble, when the last one started, and whether they stopped. */
  #recoveries = 0;
  #recoveredAt = -Infinity;
  #recoveriesStopped = false;
  /** The camera's latest track, which a viewfinder keeps while the camera opens again, until the next one arrives. */
  #last: Track | null = null;
  readonly #watched = new WeakSet<Track>();

  constructor(
    device: CaptureDevice<Track>,
    diagnostic: (diagnostic: PlayerDiagnostic) => void,
    options: SessionCameraOptions = {},
  ) {
    this.#device = device;
    this.#diagnostic = diagnostic;
    this.#chosen = options.chosen ?? (() => null);
    this.#visible =
      options.visible ??
      (() => typeof document === "undefined" || document.visibilityState !== "hidden");
    this.#wait =
      options.wait ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.#now = options.now ?? (() => performance.now());
  }

  get available(): boolean {
    return this.#unavailable === null;
  }

  /**
   * The open camera's track for a viewfinder; never part of runtime state. Every way the camera becomes unavailable
   * stops its stream, so an unavailable camera has none. While the camera switches or opens again, the viewfinder keeps
   * the previous track, so it stays in place until the next track replaces it.
   */
  get previewTrack(): Track | null {
    return this.#device.track("camera") ?? (this.#unavailable === null ? this.#last : null);
  }

  /** The cameras the browser reports, in its order; none before the player allows a camera, or when it lists none. */
  async cameras(): Promise<readonly CaptureDeviceInfo[]> {
    const listed = await this.#device.listDevices();
    if (listed.kind === "failed") return [];
    return listed.devices.filter((device) => device.kind === "camera" && device.deviceId !== "");
  }

  /**
   * Switches the open camera to the camera `deviceId` without closing the session camera: a photo taken meanwhile comes
   * from the next camera. One that cannot be opened opens the chosen or the default camera again. `true` once the
   * camera switched; `false` when it is not open, is already switching or opening again, or could not switch.
   */
  switchTo(deviceId: string): Promise<boolean> {
    if (this.#unavailable !== null || this.#switching !== null || this.#recovering !== null)
      return Promise.resolve(false);
    const generation = this.#generation;
    const switching = this.#switch(deviceId, generation).finally(() => {
      if (this.#switching === switching) this.#switching = null;
    });
    this.#switching = switching;
    return switching;
  }

  async #switch(deviceId: string, generation: number): Promise<boolean> {
    const outcome = await this.#acquire({ camera: { deviceId } });
    if (generation !== this.#generation || outcome.kind !== "failed")
      return outcome.kind === "active";
    // Most phones open one camera at a time, so the previous camera already closed.
    const reopened = await this.#openChosen(generation);
    if (generation === this.#generation && reopened.kind === "failed")
      this.#markUnavailable(
        REASONS[reopened.failure.kind],
        "could not be opened again",
        reopened.failure,
      );
    return false;
  }

  /**
   * Opens the camera the player chose, or the browser's default camera without a choice or once the browser no longer
   * has the chosen one. Browsers such as Chromium open only an exactly requested camera, not merely a preferred one.
   */
  async #openChosen(generation: number): Promise<AcquireOutcome> {
    const chosen = this.#chosen();
    if (chosen !== null) {
      const outcome = await this.#acquire({ camera: { deviceId: chosen } });
      const gone =
        outcome.kind === "failed" &&
        (outcome.failure.kind === "not-found" || outcome.failure.kind === "overconstrained");
      if (!gone || generation !== this.#generation) return outcome;
    }
    return this.#acquire({ camera: {} });
  }

  /** Opens a camera; an opened track is kept for viewfinders, and its muting is watched. */
  async #acquire(request: CaptureRequest): Promise<AcquireOutcome> {
    const outcome = await this.#device.acquire(request);
    const track = this.#device.track("camera");
    if (outcome.kind !== "active" || track === null) return outcome;
    this.#last = track;
    if (!this.#watched.has(track)) {
      this.#watched.add(track);
      track.addEventListener("mute", () => {
        if (this.#device.track("camera") === track) void this.#muted(track);
      });
    }
    return outcome;
  }

  /**
   * Opens the camera for a starting session; resolves once the browser answered, also after a permission prompt.
   * Keeps an already open camera, for example when the same page continues a session. Returns `false` when the
   * session was released meanwhile.
   */
  async open(enabled: boolean): Promise<boolean> {
    const generation = this.#generation;
    if (!enabled) {
      this.#unavailable = "unconfigured";
      return true;
    }
    if (this.#unavailable === null && this.#device.state("camera").status === "active") return true;
    const outcome = await this.#openChosen(generation);
    if (generation !== this.#generation) return false;
    if (outcome.kind === "active") this.#unavailable = null;
    else if (outcome.kind === "failed")
      this.#markUnavailable(REASONS[outcome.failure.kind], "could not be opened", outcome.failure);
    return true;
  }

  /** Call when the browser or the operating system ended the camera stream: the camera opens again. */
  ended(): void {
    this.#trouble();
  }

  /** Call when the page is shown again: a camera that ended meanwhile opens again, as does one that stays muted. */
  shown(): void {
    if (this.#unavailable !== null) return;
    // A phone's camera stopping in the background is expected, so each return starts a new run of trouble.
    this.#recoveries = 0;
    this.#recoveriesStopped = false;
    const track = this.#device.track("camera");
    const status = this.#device.state("camera").status;
    // A stream that ended, also one that ended without an event, or a recovery the hidden page interrupted.
    if (status === "ended" || status === "failed" || track?.readyState === "ended") this.#trouble();
    else if (track?.muted === true) void this.#muted(track);
  }

  /** Call when a viewfinder's picture stopped while the page is shown: the camera opens again. */
  stalled(): void {
    this.#trouble();
  }

  /** A muted camera delivers no frames; a phone's usually resumes once the page is shown again, otherwise it reopens. */
  async #muted(track: Track): Promise<void> {
    // `shown` looks again once the page is shown.
    if (!this.#visible()) return;
    await this.#wait(MUTE_GRACE_MS);
    if (this.#device.track("camera") === track && track.muted === true) this.#trouble();
  }

  /** Opens the camera again with the same choice of camera, unless it is already opening or the page is hidden. */
  #trouble(): void {
    if (this.#unavailable !== null || this.#switching !== null || this.#recovering !== null) return;
    if (this.#recoveriesStopped || !this.#visible()) return;
    const now = this.#now();
    if (now - this.#recoveredAt >= RECOVERY_SPACING_MS) this.#recoveries = 0;
    if (this.#recoveries >= RECOVERIES) {
      // Trouble that keeps coming back right after each recovery stops them: a camera whose stream is gone or ended,
      // also without an event, then stays unavailable, and one with a live stream, such as a muted one, is left to
      // resume by itself.
      this.#recoveriesStopped = true;
      const track = this.#device.track("camera");
      if (track === null || track.readyState === "ended")
        this.#markUnavailable("revoked", "kept stopping after it was opened again");
      return;
    }
    this.#recoveries++;
    this.#recoveredAt = now;
    const recovering = this.#recover(this.#generation).finally(() => {
      if (this.#recovering === recovering) this.#recovering = null;
    });
    this.#recovering = recovering;
  }

  async #recover(generation: number): Promise<void> {
    let failure: CaptureFailure | null = null;
    for (const delay of RECOVERY_DELAYS_MS) {
      if (delay > 0) await this.#wait(delay);
      // A hidden page cannot get the camera back; `shown` starts again.
      if (generation !== this.#generation || !this.#visible()) return;
      const outcome = await this.#openChosen(generation);
      if (generation !== this.#generation || outcome.kind !== "failed") return;
      failure = outcome.failure;
      // A refusal is never asked again.
      if (failure.kind === "denied") break;
    }
    if (failure !== null)
      this.#markUnavailable(REASONS[failure.kind], "could not be opened again", failure);
  }

  /** Captures a photo for `takePhoto()`, or reports why the camera is unavailable. */
  async answer(): Promise<PlayerCaptureAnswer> {
    const generation = this.#generation;
    let photo = await this.#capture(generation);
    // A stream that ended, switched, or opened again while the photo waited for its frame leaves the camera to its
    // successor, and the photo comes from that one.
    if (photo === "retired") photo = await this.#capture(generation);
    return photo === "retired" ? { kind: "unavailable", reason: "revoked" } : photo;
  }

  /** One try at a photo; `"retired"` when its stream ended or was replaced while the photo was taken. */
  async #capture(generation: number): Promise<PlayerCaptureAnswer | "retired"> {
    // A photo never comes from a dead stream: it waits for a switch, or for the camera to open again, which it starts
    // itself when nothing noticed earlier that the stream ended or stays muted.
    if (this.#switching !== null) await this.#switching;
    const track = this.#device.track("camera");
    if (track === null || track.readyState === "ended") this.#trouble();
    else if (track.muted === true) await this.#muted(track);
    if (this.#recovering !== null) await this.#recovering;
    if (generation !== this.#generation) return { kind: "unavailable", reason: "revoked" };
    if (this.#unavailable !== null) return { kind: "unavailable", reason: this.#unavailable };
    // Still without a picture, as on a hidden page: no photo this time, and the camera opens again once it is shown.
    const live = this.#device.track("camera");
    if (live === null || live.readyState === "ended" || live.muted === true)
      return { kind: "unavailable", reason: "revoked" };
    const photo = await this.#device.capturePhoto();
    if (generation !== this.#generation) return { kind: "unavailable", reason: "revoked" };
    if (photo.kind === "photo") return { kind: "captured", reference: photo.media.reference };
    if (photo.failure.kind === "inactive" || live.readyState !== "live") return "retired";
    this.#markUnavailable(REASONS[photo.failure.kind], "could not capture a photo", photo.failure);
    return { kind: "unavailable", reason: REASONS[photo.failure.kind] };
  }

  /** Releases the camera, for example when the session ends, is replaced, or the Player unmounts. */
  release(): void {
    this.#generation++;
    this.#unavailable = "unconfigured";
    this.#switching = null;
    this.#recovering = null;
    this.#recoveries = 0;
    this.#recoveredAt = -Infinity;
    this.#recoveriesStopped = false;
    this.#last = null;
    this.#device.reset();
  }

  #markUnavailable(
    reason: CaptureUnavailableReason,
    what: string,
    failure?: { readonly error?: string },
  ): void {
    this.#unavailable = reason;
    // Whether opening or capturing failed, and the browser's exception name, tell device problems apart.
    const cause = failure?.error === undefined ? reason : `${reason}, ${failure.error}`;
    this.#diagnostic({
      code: `camera-${reason}`,
      message: `The session camera ${what} (${cause}); it stays unavailable for this session.`,
    });
    // A failed or revoked camera stays closed for the rest of the session.
    this.#device.stop("camera");
  }
}

export interface CaptureServiceHost {
  /** The published session, or `null` before one starts. */
  session(): PlayerRuntimeSession | null;
  /** Identifies the published session; it changes when another session starts. */
  generation(): number;
  /**
   * Observes the current time, publishes the result, and returns the published session; `null` when the session takes
   * no input, as once a Player error stopped it.
   */
  observe(): PlayerRuntimeSession | null;
  publish(session: PlayerRuntimeSession): void;
  readonly capturedMedia: CapturedMediaAdmission;
  diagnostic(diagnostic: PlayerDiagnostic): void;
  /** Runs `task` later, after the engine had a chance to run. */
  later(task: () => void): void;
}

/**
 * Answers each pending `takePhoto()` once and delivers that answer until the runtime settles it. When the runtime
 * cannot take it yet (`executionPending`), the same answer is offered again later, never a second photo. Action IDs
 * restart with every session, so an answer belongs to one session and one action; when the session is replaced while
 * an answer is captured, the successor's capture is serviced next.
 */
export class CaptureService {
  readonly #answer: () => Promise<PlayerCaptureAnswer>;
  readonly #host: CaptureServiceHost;
  #key: string | null = null;
  #pending: Promise<PlayerCaptureAnswer> | null = null;
  #servicing = false;
  #scheduled = false;
  #stopped = false;

  constructor(answer: () => Promise<PlayerCaptureAnswer>, host: CaptureServiceHost) {
    this.#answer = answer;
    this.#host = host;
  }

  /**
   * Services the published session's pending capture soon; call whenever the session changes. Servicing always runs
   * in a later task, so a script that captures in a loop still lets the browser handle input and rendering.
   */
  request(): void {
    if (this.#scheduled || this.#stopped) return;
    this.#scheduled = true;
    this.#host.later(() => {
      this.#scheduled = false;
      void this.#service();
    });
  }

  /** Stops servicing, for example when the Player unmounts; answers still in flight are dropped. */
  stop(): void {
    this.#stopped = true;
    this.#key = null;
    this.#pending = null;
  }

  /** Forgets the answer being taken, as for a new or stopped session; one still in flight is dropped. */
  reset(): void {
    this.#key = null;
    this.#pending = null;
  }

  async #service(): Promise<void> {
    const current = this.#host.session();
    const action = current && activePlayerRuntimeCapture(current.state);
    if (!action || this.#servicing || this.#stopped) return;
    this.#servicing = true;
    const generation = this.#host.generation();
    const key = `${generation}:${action.actionId}`;
    try {
      if (this.#key !== key || this.#pending === null) {
        this.#key = key;
        this.#pending = this.#answer();
      }
      const answer = await this.#pending;
      if (this.#stopped || this.#key !== key || this.#host.generation() !== generation) return;
      // Input happens at the observed time.
      const observed = this.#host.observe();
      if (!observed || activePlayerRuntimeCapture(observed.state)?.actionId !== action.actionId) {
        this.#settled(key);
        return;
      }
      const result = answerPlayerRuntimeCapture(
        observed,
        action.actionId,
        answer,
        this.#host.capturedMedia,
      );
      // `executionPending`: the same answer is offered again in the next service.
      if (result.outcome.kind === "executionPending") return;
      this.#settled(key);
      if (result.outcome.kind === "invalidPayload") {
        this.#host.diagnostic({ code: "capture-rejected", message: result.outcome.message });
        // Never leave the script waiting: answer this capture as unavailable instead.
        this.#host.publish(
          answerPlayerRuntimeCapture(observed, action.actionId, {
            kind: "unavailable",
            reason: "failed",
          }).session,
        );
        return;
      }
      if (result.outcome.kind === "completed") this.#host.publish(result.session);
    } finally {
      this.#servicing = false;
      // A retry, or the next capture of the same or a replacing session.
      this.request();
    }
  }

  #settled(key: string): void {
    if (this.#key !== key) return;
    this.#key = null;
    this.#pending = null;
  }
}
