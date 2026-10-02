import type { CapturedMediaAdmission, CaptureUnavailableReason } from "../src/index.js";
import type { CaptureDevice, CaptureFailureKind, CaptureTrack } from "./capture-device.js";
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

/**
 * The session camera: opened once when the session starts, kept open while it runs, and used silently by
 * `takePhoto()`. Any failure leaves it unavailable for the rest of the session, so later captures answer `null`
 * without opening the camera again or asking for permission again.
 */
export class SessionCamera<Track extends CaptureTrack> {
  readonly #device: CaptureDevice<Track>;
  readonly #diagnostic: (diagnostic: PlayerDiagnostic) => void;
  #unavailable: CaptureUnavailableReason | null = "unconfigured";
  /** Increments when the session camera is released, so late results of an earlier session are ignored. */
  #generation = 0;

  constructor(device: CaptureDevice<Track>, diagnostic: (diagnostic: PlayerDiagnostic) => void) {
    this.#device = device;
    this.#diagnostic = diagnostic;
  }

  get available(): boolean {
    return this.#unavailable === null;
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
    const outcome = await this.#device.acquire({ camera: {} });
    if (generation !== this.#generation) return false;
    if (outcome.kind === "active") this.#unavailable = null;
    else if (outcome.kind === "failed") this.#markUnavailable(REASONS[outcome.failure.kind]);
    return true;
  }

  /** Call when the browser or the operating system ended the camera stream. */
  revoked(): void {
    if (this.#unavailable === null) this.#markUnavailable("revoked");
  }

  /** Captures a photo for `takePhoto()`, or reports why the camera is unavailable. */
  async answer(): Promise<PlayerCaptureAnswer> {
    const generation = this.#generation;
    if (this.#unavailable !== null) return { kind: "unavailable", reason: this.#unavailable };
    const photo = await this.#device.capturePhoto();
    if (generation !== this.#generation) return { kind: "unavailable", reason: "revoked" };
    if (photo.kind === "photo") return { kind: "captured", reference: photo.media.reference };
    this.#markUnavailable(REASONS[photo.failure.kind]);
    return { kind: "unavailable", reason: REASONS[photo.failure.kind] };
  }

  /** Releases the camera, for example when the session ends, is replaced, or the Player unmounts. */
  release(): void {
    this.#generation++;
    this.#unavailable = "unconfigured";
    this.#device.reset();
  }

  #markUnavailable(reason: CaptureUnavailableReason): void {
    this.#unavailable = reason;
    this.#diagnostic({
      code: `camera-${reason}`,
      message: `The session camera is unavailable (${reason}).`,
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
  /** Observes the current time, publishes the result, and returns the published session. */
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

  reset(): void {
    this.#key = null;
    this.#pending = null;
  }

  async #service(): Promise<void> {
    const current = this.#host.session();
    const action = current && activePlayerRuntimeCapture(current.snapshot);
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
      if (this.#stopped || this.#host.generation() !== generation) return;
      // Input happens at the observed time.
      const observed = this.#host.observe() ?? this.#host.session();
      if (
        !observed ||
        activePlayerRuntimeCapture(observed.snapshot)?.actionId !== action.actionId
      ) {
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
