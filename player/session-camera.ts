import type { CaptureUnavailableReason } from "../src/index.js";
import type { CaptureDevice, CaptureFailureKind, CaptureTrack } from "./capture-device.js";
import type { PlayerCaptureAnswer } from "./runtime-adapter.js";

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

/**
 * Delivers one answer per capture action until the runtime settles it. A capture is answered once; when the runtime
 * cannot take the answer yet (`executionPending`), the same answer is offered again after the engine ran, never a
 * second photo.
 */
export class CaptureDelivery {
  #actionId: number | null = null;
  #answer: Promise<PlayerCaptureAnswer> | null = null;

  /** The answer for `actionId`, captured on first request. */
  answerFor(
    actionId: number,
    capture: () => Promise<PlayerCaptureAnswer>,
  ): Promise<PlayerCaptureAnswer> {
    if (this.#actionId !== actionId || this.#answer === null) {
      this.#actionId = actionId;
      this.#answer = capture();
    }
    return this.#answer;
  }

  /** Forgets the answer once its action settled or is gone. */
  settled(actionId: number): void {
    if (this.#actionId !== actionId) return;
    this.#actionId = null;
    this.#answer = null;
  }

  reset(): void {
    this.#actionId = null;
    this.#answer = null;
  }
}
