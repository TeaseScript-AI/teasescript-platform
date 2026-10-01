import { RgbaImage } from "./rgba-image.js";
import type { SessionMediaEntry, SessionMediaStore } from "./session-media.js";

/**
 * Player-owned camera and microphone capture. The Player owns every physical browser stream; the runtime and package
 * code only ever receive serializable results such as session media references or pixel data copied out of a frame.
 * Browser APIs stay behind `CaptureHost`, so lifecycle, cleanup and failure handling are testable with fakes.
 */

export type CaptureSourceKind = "camera" | "microphone";

/** The browser track surface the device uses; `MediaStreamTrack` satisfies it. */
export interface CaptureTrack {
  readonly kind: string;
  readonly label: string;
  readonly readyState: "live" | "ended";
  stop(): void;
  addEventListener(type: "ended", listener: () => void): void;
}

export interface CameraRequest {
  readonly deviceId?: string;
  /** Preferred frame size; the browser may deliver another size. */
  readonly width?: number;
  readonly height?: number;
}

export interface MicrophoneRequest {
  readonly deviceId?: string;
}

export interface CaptureRequest {
  readonly camera?: CameraRequest;
  readonly microphone?: MicrophoneRequest;
}

export interface CaptureDeviceInfo {
  readonly kind: CaptureSourceKind;
  readonly deviceId: string;
  /** Empty until the browser grants access; device identifiers are not stable author-facing identity. */
  readonly label: string;
}

/** Receives recorded data; a recorder calls `stopped` or `failed` exactly once, after its last `data`. */
export interface CaptureRecorderSink {
  data(chunk: Blob): void;
  stopped(): void;
  failed(error: unknown): void;
}

export interface CaptureRecorder {
  /** The container type of the produced data, known once the recorder exists. */
  readonly mimeType: string;
  start(sink: CaptureRecorderSink): void;
  stop(): void;
}

/** Live microphone analysis; `MediaStream` audio through an analyser node is the browser implementation. */
export interface AudioSampler {
  /** Whether samples are live; a suspended audio context reads silence. */
  readonly running: boolean;
  readonly sampleRate: number;
  /** Number of samples `readTimeDomain` fills; `readFrequency` fills half as many bins. */
  readonly windowSize: number;
  readTimeDomain(target: Float32Array<ArrayBuffer>): void;
  readFrequency(target: Float32Array<ArrayBuffer>): void;
  close(): void;
}

export interface CaptureHost<Track extends CaptureTrack> {
  /** Requests the given sources in one browser request; rejects with the browser's exception. */
  acquire(request: CaptureRequest): Promise<readonly Track[]>;
  listDevices(): Promise<readonly CaptureDeviceInfo[]>;
  createRecorder(tracks: readonly Track[]): CaptureRecorder;
  grabFrame(track: Track): Promise<RgbaImage>;
  encodeImage(image: RgbaImage): Promise<Blob>;
  decodeImage(data: Blob): Promise<RgbaImage>;
  createAudioSampler(track: Track): AudioSampler;
  /** Monotonic milliseconds, used only for recording duration. */
  now(): number;
  stateChanged(kind: CaptureSourceKind, state: CaptureSourceState): void;
}

export type CaptureFailureKind =
  "denied" | "not-found" | "busy" | "overconstrained" | "unsupported" | "inactive" | "failed";

export interface CaptureFailure {
  readonly kind: CaptureFailureKind;
  readonly message: string;
}

const FAILURE_MESSAGES: Readonly<Record<CaptureFailureKind, string>> = {
  denied: "Access to the device was denied.",
  "not-found": "No matching device was found.",
  busy: "The device is in use or could not be started.",
  overconstrained: "The device cannot satisfy the requested settings.",
  unsupported: "This browser does not support the requested capture.",
  inactive: "The required device is not active.",
  failed: "The capture failed.",
};

function failure(kind: CaptureFailureKind): CaptureFailure {
  return { kind, message: FAILURE_MESSAGES[kind] };
}

/**
 * Translates a browser exception into a bounded failure. Browser messages are not forwarded: they vary by browser,
 * may name hardware, and are not a stable contract.
 */
export function captureFailure(error: unknown): CaptureFailure {
  const name =
    typeof error === "object" && error !== null && "name" in error ? String(error.name) : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return failure("denied");
    case "NotFoundError":
      return failure("not-found");
    case "NotReadableError":
    case "AbortError":
      return failure("busy");
    case "OverconstrainedError":
      return failure("overconstrained");
    case "NotSupportedError":
    case "TypeError":
      return failure("unsupported");
    default:
      return failure("failed");
  }
}

export type CaptureSourceState =
  | { readonly status: "idle" }
  | { readonly status: "acquiring" }
  | { readonly status: "active"; readonly label: string }
  /** The browser or operating system ended the stream, for example on revocation or disconnection. */
  | { readonly status: "ended" }
  | { readonly status: "failed"; readonly failure: CaptureFailure };

export type AcquireOutcome =
  | { readonly kind: "active" }
  /** A later acquire, stop or reset replaced this request before it finished. */
  | { readonly kind: "superseded" }
  | { readonly kind: "failed"; readonly failure: CaptureFailure };

export type FrameOutcome =
  | { readonly kind: "frame"; readonly image: RgbaImage }
  | { readonly kind: "failed"; readonly failure: CaptureFailure };

export type PhotoOutcome =
  | { readonly kind: "photo"; readonly media: SessionMediaEntry }
  | { readonly kind: "failed"; readonly failure: CaptureFailure };

export type RecordingOutcome =
  | {
      readonly kind: "recorded";
      readonly media: SessionMediaEntry;
      readonly durationMs: number;
      /** A recorded source ended or was stopped before `stop()`; the media holds what was recorded until then. */
      readonly interrupted: boolean;
    }
  | { readonly kind: "cancelled" }
  | { readonly kind: "failed"; readonly failure: CaptureFailure };

export type RecordingStart =
  | { readonly kind: "recording"; readonly recording: CaptureRecording }
  | { readonly kind: "failed"; readonly failure: CaptureFailure };

export type SamplerOutcome =
  | { readonly kind: "sampler"; readonly sampler: AudioSampler }
  | { readonly kind: "failed"; readonly failure: CaptureFailure };

interface Source<Track> {
  state: CaptureSourceState;
  track: Track | null;
  /** Increments on every acquire, stop and reset, so late browser results can be recognized and released. */
  generation: number;
}

/** One running recording; `finished` settles exactly once. */
export interface CaptureRecording {
  readonly sources: readonly CaptureSourceKind[];
  readonly finished: Promise<RecordingOutcome>;
  /** Finishes the recording and stores what was recorded. */
  stop(): void;
  /** Discards the recording; nothing is stored. */
  cancel(): void;
}

/**
 * Owns at most one camera stream and one microphone stream. Requesting a source that is already active stops the
 * previous stream before opening the new one, so only one physical camera is open at a time. Stopping a source, or the
 * browser ending it, interrupts a recording that uses it and closes samplers on it.
 */
export class CaptureDevice<Track extends CaptureTrack> {
  readonly #host: CaptureHost<Track>;
  readonly #media: SessionMediaStore;
  readonly #sources: Record<CaptureSourceKind, Source<Track>> = {
    camera: { state: { status: "idle" }, track: null, generation: 0 },
    microphone: { state: { status: "idle" }, track: null, generation: 0 },
  };
  readonly #samplers = new Set<AudioSampler>();
  #recording: Recording | null = null;

  constructor(host: CaptureHost<Track>, media: SessionMediaStore) {
    this.#host = host;
    this.#media = media;
  }

  state(kind: CaptureSourceKind): CaptureSourceState {
    return this.#sources[kind].state;
  }

  /** The live track, for example to attach a preview; never part of runtime state. */
  track(kind: CaptureSourceKind): Track | null {
    return this.#sources[kind].track;
  }

  get recording(): CaptureRecording | null {
    return this.#recording;
  }

  async listDevices(): Promise<
    | { readonly kind: "devices"; readonly devices: readonly CaptureDeviceInfo[] }
    | { readonly kind: "failed"; readonly failure: CaptureFailure }
  > {
    try {
      return { kind: "devices", devices: await this.#host.listDevices() };
    } catch (error) {
      return { kind: "failed", failure: captureFailure(error) };
    }
  }

  /**
   * Opens the requested sources in one browser request, replacing any active stream of the same kind. Sources that
   * are not requested are left untouched.
   */
  async acquire(request: CaptureRequest): Promise<AcquireOutcome> {
    const kinds = requestedKinds(request);
    if (kinds.length === 0) return { kind: "active" };
    const generations = new Map<CaptureSourceKind, number>();
    for (const kind of kinds) {
      this.#release(kind);
      const source = this.#sources[kind];
      generations.set(kind, ++source.generation);
      this.#setState(kind, { status: "acquiring" });
    }
    let tracks: readonly Track[];
    try {
      tracks = await this.#host.acquire(request);
    } catch (error) {
      const failed = captureFailure(error);
      let current = false;
      for (const kind of kinds) {
        if (this.#sources[kind].generation !== generations.get(kind)) continue;
        current = true;
        this.#setState(kind, { status: "failed", failure: failed });
      }
      return current ? { kind: "failed", failure: failed } : { kind: "superseded" };
    }
    const assigned = new Set<Track>();
    let missing = false;
    let superseded = false;
    for (const kind of kinds) {
      const source = this.#sources[kind];
      const track = tracks.find((candidate) => candidate.kind === trackKind(kind));
      if (source.generation !== generations.get(kind)) {
        superseded = true;
        continue;
      }
      if (track === undefined || track.readyState === "ended") {
        missing = true;
        this.#setState(kind, { status: "failed", failure: failure("not-found") });
        continue;
      }
      assigned.add(track);
      this.#attach(kind, track);
    }
    // Release every track nobody owns: unrequested kinds, duplicates, and results of superseded requests.
    for (const track of tracks) if (!assigned.has(track)) track.stop();
    if (missing) return { kind: "failed", failure: failure("not-found") };
    return superseded ? { kind: "superseded" } : { kind: "active" };
  }

  /** Stops one source; a pending acquisition of that kind is abandoned and its stream released on arrival. */
  stop(kind: CaptureSourceKind): void {
    const source = this.#sources[kind];
    source.generation++;
    this.#release(kind);
    if (source.state.status !== "idle") this.#setState(kind, { status: "idle" });
  }

  /** Copies the current camera frame; recording on the same stream continues. */
  async captureFrame(): Promise<FrameOutcome> {
    const track = this.#liveTrack("camera");
    if (track === null) return { kind: "failed", failure: failure("inactive") };
    const generation = this.#sources.camera.generation;
    let image: RgbaImage;
    try {
      image = await this.#host.grabFrame(track);
    } catch (error) {
      return { kind: "failed", failure: captureFailure(error) };
    }
    // A frame that arrives after the camera stopped or switched is not from the current camera.
    if (this.#sources.camera.generation !== generation || this.#sources.camera.track !== track)
      return { kind: "failed", failure: failure("inactive") };
    return { kind: "frame", image };
  }

  /** Captures a still frame into session media. */
  async capturePhoto(): Promise<PhotoOutcome> {
    const frame = await this.captureFrame();
    if (frame.kind === "failed") return frame;
    try {
      const data = await this.#host.encodeImage(frame.image);
      return {
        kind: "photo",
        media: this.#media.add("image", data, {
          width: frame.image.width,
          height: frame.image.height,
        }),
      };
    } catch (error) {
      return { kind: "failed", failure: captureFailure(error) };
    }
  }

  /** Decodes stored session image media for pixel access. */
  async readImage(reference: string): Promise<FrameOutcome> {
    const entry = this.#media.get(reference);
    if (entry === null || entry.kind !== "image")
      return { kind: "failed", failure: failure("not-found") };
    try {
      return { kind: "frame", image: await this.#host.decodeImage(entry.data) };
    } catch (error) {
      return { kind: "failed", failure: captureFailure(error) };
    }
  }

  /** Opens live microphone analysis; the sampler is closed when the microphone stops. */
  openAudioSampler(): SamplerOutcome {
    const track = this.#liveTrack("microphone");
    if (track === null) return { kind: "failed", failure: failure("inactive") };
    let created: AudioSampler;
    try {
      created = this.#host.createAudioSampler(track);
    } catch (error) {
      return { kind: "failed", failure: captureFailure(error) };
    }
    const samplers = this.#samplers;
    let closed = false;
    const sampler: AudioSampler = {
      get running() {
        return !closed && created.running;
      },
      sampleRate: created.sampleRate,
      windowSize: created.windowSize,
      readTimeDomain: (target) => {
        if (!closed) created.readTimeDomain(target);
      },
      readFrequency: (target) => {
        if (!closed) created.readFrequency(target);
      },
      close() {
        if (closed) return;
        closed = true;
        samplers.delete(sampler);
        created.close();
      },
    };
    this.#samplers.add(sampler);
    return { kind: "sampler", sampler };
  }

  /**
   * Records the given active sources together, for example camera only, microphone only, or both. One recording runs
   * at a time, including while a stopped recording still receives its last data.
   */
  startRecording(sources: readonly CaptureSourceKind[]): RecordingStart {
    const kinds = [...new Set(sources)];
    if (kinds.length === 0 || this.#recording !== null)
      return { kind: "failed", failure: failure(kinds.length === 0 ? "inactive" : "busy") };
    const tracks: Track[] = [];
    for (const kind of kinds) {
      const track = this.#liveTrack(kind);
      if (track === null) return { kind: "failed", failure: failure("inactive") };
      tracks.push(track);
    }
    let recorder: CaptureRecorder;
    try {
      recorder = this.#host.createRecorder(tracks);
    } catch (error) {
      return { kind: "failed", failure: captureFailure(error) };
    }
    const recording = new Recording(kinds, recorder, this.#host, this.#media, () => {
      if (this.#recording === recording) this.#recording = null;
    });
    this.#recording = recording;
    const failed = recording.start();
    return failed === null ? { kind: "recording", recording } : { kind: "failed", failure: failed };
  }

  /** Cancels any recording, closes samplers and stops every stream, for example when the session ends. */
  reset(): void {
    this.#recording?.cancel();
    this.stop("camera");
    this.stop("microphone");
  }

  #liveTrack(kind: CaptureSourceKind): Track | null {
    const source = this.#sources[kind];
    return source.state.status === "active" && source.track?.readyState === "live"
      ? source.track
      : null;
  }

  #attach(kind: CaptureSourceKind, track: Track): void {
    const source = this.#sources[kind];
    source.track = track;
    const generation = source.generation;
    track.addEventListener("ended", () => {
      if (source.generation !== generation || source.track !== track) return;
      this.#release(kind);
      this.#setState(kind, { status: "ended" });
    });
    this.#setState(kind, { status: "active", label: track.label });
  }

  /** Stops the stream of one kind and everything that depends on it; the state is left to the caller. */
  #release(kind: CaptureSourceKind): void {
    const source = this.#sources[kind];
    const track = source.track;
    if (track === null) return;
    source.track = null;
    if (this.#recording?.sources.includes(kind)) this.#recording.interrupt();
    if (kind === "microphone") for (const sampler of [...this.#samplers]) sampler.close();
    track.stop();
  }

  #setState(kind: CaptureSourceKind, state: CaptureSourceState): void {
    this.#sources[kind].state = state;
    this.#host.stateChanged(kind, state);
  }
}

class Recording implements CaptureRecording {
  readonly sources: readonly CaptureSourceKind[];
  readonly finished: Promise<RecordingOutcome>;
  readonly #recorder: CaptureRecorder;
  readonly #clock: { now(): number };
  readonly #media: SessionMediaStore;
  readonly #settled: () => void;
  readonly #chunks: Blob[] = [];
  readonly #startedAt: number;
  #resolve!: (outcome: RecordingOutcome) => void;
  /** When recording ended; `null` while the recorder still records. */
  #endedAt: number | null = null;
  #interrupted = false;
  #done = false;

  constructor(
    sources: readonly CaptureSourceKind[],
    recorder: CaptureRecorder,
    clock: { now(): number },
    media: SessionMediaStore,
    settled: () => void,
  ) {
    this.sources = sources;
    this.#recorder = recorder;
    this.#clock = clock;
    this.#media = media;
    this.#settled = settled;
    this.#startedAt = clock.now();
    this.finished = new Promise((resolve) => (this.#resolve = resolve));
  }

  /** Starts the recorder; returns the failure when it cannot start. */
  start(): CaptureFailure | null {
    try {
      this.#recorder.start({
        data: (chunk) => {
          if (!this.#done) this.#chunks.push(chunk);
        },
        stopped: () => this.#stored(),
        failed: (error) => this.#finish({ kind: "failed", failure: captureFailure(error) }),
      });
      return null;
    } catch (error) {
      const failed = captureFailure(error);
      this.#finish({ kind: "failed", failure: failed });
      return failed;
    }
  }

  stop(): void {
    this.#end(false);
  }

  /** Ends the recording because a recorded source stopped; what was recorded is kept. */
  interrupt(): void {
    this.#end(true);
  }

  cancel(): void {
    if (this.#done) return;
    const recording = this.#endedAt === null;
    this.#finish({ kind: "cancelled" });
    if (!recording) return;
    try {
      this.#recorder.stop();
    } catch {
      // Nothing is kept from a cancelled recording, so a failing stop changes nothing.
    }
  }

  #end(interrupted: boolean): void {
    if (this.#done || this.#endedAt !== null) return;
    this.#endedAt = this.#clock.now();
    this.#interrupted = interrupted;
    // The recorder delivers its last data before it reports `stopped`.
    try {
      this.#recorder.stop();
    } catch (error) {
      this.#finish({ kind: "failed", failure: captureFailure(error) });
    }
  }

  #stored(): void {
    if (this.#done) return;
    // A recorder may also stop by itself, for example when every recorded track ended.
    const interrupted = this.#interrupted || this.#endedAt === null;
    const durationMs = Math.max(0, (this.#endedAt ?? this.#clock.now()) - this.#startedAt);
    const data = new Blob(this.#chunks, { type: this.#recorder.mimeType });
    const kind = this.sources.includes("camera") ? "video" : "audio";
    this.#finish({
      kind: "recorded",
      media: this.#media.add(kind, data, { durationMs }),
      durationMs,
      interrupted,
    });
  }

  #finish(outcome: RecordingOutcome): void {
    if (this.#done) return;
    this.#done = true;
    this.#chunks.length = 0;
    this.#settled();
    this.#resolve(outcome);
  }
}

function requestedKinds(request: CaptureRequest): CaptureSourceKind[] {
  const kinds: CaptureSourceKind[] = [];
  if (request.camera !== undefined) kinds.push("camera");
  if (request.microphone !== undefined) kinds.push("microphone");
  return kinds;
}

function trackKind(kind: CaptureSourceKind): "video" | "audio" {
  return kind === "camera" ? "video" : "audio";
}
