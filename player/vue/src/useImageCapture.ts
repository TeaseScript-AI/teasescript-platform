import { computed, onScopeDispose, shallowRef, watch, type Ref, type ShallowRef } from "vue";
import type { CapturedMediaStore } from "../../captured-media.js";
import {
  activePlayerRuntimeInteraction,
  answerPlayerRuntimeImage,
  type PlayerRuntimeSession,
} from "../../runtime-adapter.js";
import type { SessionCamera } from "../../session-camera.js";

/**
 * Where taking a photo for an `askImage` request stands: the camera opening, the live view the player frames the photo
 * in, the countdown before the photo, the photo being taken, the photo the player may use or take again, or a camera
 * that cannot be used.
 */
export type ImageCapturePhase =
  "opening" | "live" | "countdown" | "taking" | "review" | "unavailable";

/** The seconds counted down from the shutter to the photo. */
const COUNTDOWN_SECONDS = 5;

/** What the capture view on the Stage shows. */
export interface ImageCaptureView {
  readonly phase: ImageCapturePhase;
  /** The request's message, the question the photo answers. */
  readonly question: string;
  /** The live camera while the player frames the photo. */
  readonly track: MediaStreamTrack | null;
  /** The photo taken, while the player decides whether to use it. */
  readonly photo: string | null;
  /** The seconds left before the photo is taken, during the countdown. */
  readonly countdown: number | null;
}

interface Capture {
  /** The request being answered: the session's generation and the request's action. */
  readonly generation: number;
  readonly actionId: number;
  readonly question: string;
  readonly phase: ImageCapturePhase;
  /** The stored photo while it is reviewed; it becomes the answer only through `use`. */
  readonly reference: string | null;
  /** Whether the capture uses the camera it opened itself rather than the session camera. */
  readonly own: boolean;
  readonly countdown: number | null;
}

export interface ImageCaptureHost {
  readonly session: ShallowRef<PlayerRuntimeSession | null>;
  readonly generation: Readonly<Ref<number>>;
  /** The session camera: a capture uses it while it is open, and never opens or releases it. */
  readonly sessionCamera: SessionCamera<MediaStreamTrack>;
  /**
   * The camera a capture opens itself as its request asks, while the session camera is not open. Only captures use it,
   * so it never serves `takePhoto()` or a script's camera view, and it is released when the capture ends.
   */
  readonly captureCamera: SessionCamera<MediaStreamTrack>;
  /** Changes whenever a camera may have opened, failed, ended, or been released. */
  readonly cameraRevision: Readonly<Ref<number>>;
  readonly media: CapturedMediaStore;
  /** Whether a camera can be used here at all; without it no capture opens. */
  readonly offered: boolean;
  /** Observes the current time, publishes the result, and returns the published session. */
  observe(): PlayerRuntimeSession | null;
  publish(session: PlayerRuntimeSession): void;
  /** Waits one step of the countdown; a second by default. */
  countdownStep?: () => Promise<void>;
}

/**
 * The camera route of `askImage`: as soon as a request that allows the camera is presented, its capture opens the camera
 * and shows the live picture; it ends with the request, whichever way it is answered. It is Player-only state, never
 * runtime state, so a restored session opens the camera again but never takes a photo by itself. A photo is stored as
 * session media when it is taken, answers the request only when the player uses it, and is dropped when the player
 * takes another or the capture ends.
 */
export function useImageCapture(host: ImageCaptureHost) {
  const capture = shallowRef<Capture | null>(null);
  const cameraOf = (target: Capture) => (target.own ? host.captureCamera : host.sessionCamera);

  const presentedRequest = (current: PlayerRuntimeSession | null) => {
    const action = current && activePlayerRuntimeInteraction(current.snapshot);
    return action?.ui.kind === "image" && action.ui.allowCamera ? action : null;
  };
  const answers = (current: PlayerRuntimeSession | null, target: Capture) =>
    host.generation.value === target.generation &&
    presentedRequest(current)?.actionId === target.actionId;

  function set(next: Capture | null) {
    const previous = capture.value;
    if (previous?.reference && previous.reference !== next?.reference)
      host.media.discard(previous.reference);
    capture.value = next;
    // A camera the capture opened itself is released as soon as it no longer uses it.
    if (previous?.own && !next?.own) host.captureCamera.release();
  }

  /** Continues `target` with `change` while it is still the capture of the request it answers. */
  function update(
    target: Capture,
    change: Partial<Pick<Capture, "phase" | "reference" | "own" | "countdown">>,
  ) {
    if (capture.value !== target) {
      // Only a photo taken for a capture that is gone needs dropping.
      if (change.reference) host.media.discard(change.reference);
      return null;
    }
    const next = { ...target, ...change };
    set(next);
    return next;
  }

  /** Uses the session camera while it is open; otherwise opens the capture's own camera. */
  async function openCamera(target: Capture) {
    if (host.sessionCamera.available) {
      update(target, { phase: "live", own: false });
      return;
    }
    const opening = update(target, { own: true });
    if (!opening) return;
    await host.captureCamera.open(true);
    update(opening, { phase: host.captureCamera.available ? "live" : "unavailable" });
  }

  /** Opens the capture for the presented request. */
  function open(): void {
    const request = presentedRequest(host.session.value);
    if (!host.offered || request === null || request.ui.kind !== "image" || capture.value !== null)
      return;
    const target: Capture = {
      generation: host.generation.value,
      actionId: request.actionId,
      question: request.ui.hint ?? "Take a photo",
      phase: "opening",
      reference: null,
      own: false,
      countdown: null,
    };
    set(target);
    void openCamera(target);
  }

  /** Opens the camera again after it could not be used, from "Try again". */
  function retry(): void {
    const target = capture.value;
    if (target?.phase !== "unavailable") return;
    const next = update(target, { phase: "opening" });
    if (next) void openCamera(next);
  }

  const countdownStep =
    host.countdownStep ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 1_000)));

  /** Counts down, then takes the photo the player framed; a capture that ends meanwhile takes none. */
  async function shutter(): Promise<void> {
    let target = capture.value;
    if (target?.phase !== "live") return;
    for (let count = COUNTDOWN_SECONDS; count > 0; count--) {
      const counting = update(target, { phase: "countdown", countdown: count });
      if (!counting) return;
      await countdownStep();
      target = counting;
    }
    const taking = update(target, { phase: "taking", countdown: null });
    if (!taking) return;
    const answer = await cameraOf(taking).answer();
    update(
      taking,
      answer.kind === "captured"
        ? { phase: "review", reference: answer.reference }
        : { phase: "unavailable" },
    );
  }

  /** Drops the photo and frames another, or offers "Try again" when the camera ended meanwhile. */
  function retake(): void {
    const target = capture.value;
    if (target?.phase === "review")
      update(target, {
        phase: cameraOf(target).available ? "live" : "unavailable",
        reference: null,
      });
  }

  /** Answers the request with the photo, at the observed time. */
  function use(): void {
    const target = capture.value;
    if (target?.phase !== "review" || target.reference === null) return;
    const current = host.observe() ?? host.session.value;
    if (current === null || !answers(current, target)) return set(null);
    const result = answerPlayerRuntimeImage(current, target.reference, host.media);
    if (result?.outcome.kind !== "completed") return;
    // The photo is the answer now, so it stays.
    capture.value = { ...target, reference: null };
    set(null);
    host.publish(result.session);
  }

  // A capture belongs to one request: when the request ends, however it was answered, is interrupted, or its session is
  // replaced, it closes and a camera it opened turns off; a presented request that allows the camera opens one.
  watch(
    [host.session, host.generation, capture],
    ([current]) => {
      const target = capture.value;
      if (target !== null && !answers(current, target)) set(null);
      if (capture.value === null) open();
    },
    { immediate: true },
  );
  // A camera that ends while the player frames the photo, as when it is unplugged, offers "Try again".
  watch(host.cameraRevision, () => {
    const target = capture.value;
    if ((target?.phase === "live" || target?.phase === "countdown") && !cameraOf(target).available)
      update(target, { phase: "unavailable", countdown: null });
  });

  // When the Player unmounts, the capture ends: its photo is dropped and a camera it opened turns off.
  onScopeDispose(() => set(null));

  const view = computed<ImageCaptureView | null>(() => {
    const target = capture.value;
    if (target === null) return null;
    void host.cameraRevision.value;
    const photo = target.reference === null ? null : host.media.resolve(target.reference);
    return {
      phase: target.phase,
      question: target.question,
      // The live picture stays under the photo under review, so the view keeps its size.
      track:
        target.phase === "live" ||
        target.phase === "countdown" ||
        target.phase === "taking" ||
        target.phase === "review"
          ? cameraOf(target).previewTrack
          : null,
      photo: photo?.state === "ready" ? photo.url : null,
      countdown: target.countdown,
    };
  });

  return { view, retry, shutter, retake, use };
}
