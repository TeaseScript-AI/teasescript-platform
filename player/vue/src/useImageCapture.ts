import { computed, shallowRef, watch, type Ref, type ShallowRef } from "vue";
import type { CapturedMediaStore } from "../../captured-media.js";
import {
  activePlayerRuntimeInteraction,
  answerPlayerRuntimeImage,
  type PlayerRuntimeSession,
} from "../../runtime-adapter.js";
import type { SessionCamera } from "../../session-camera.js";

/**
 * Where taking a photo for an `askImage` request stands: the camera opening, the live view the player frames the photo
 * in, the photo being taken, the photo the player may use or take again, or a camera that cannot be used.
 */
export type ImageCapturePhase = "opening" | "live" | "taking" | "review" | "unavailable";

/** What the capture view on the Stage shows. */
export interface ImageCaptureView {
  readonly phase: ImageCapturePhase;
  /** The request's message, the question the photo answers. */
  readonly question: string;
  /** The live camera while the player frames the photo. */
  readonly track: MediaStreamTrack | null;
  /** The photo taken, while the player decides whether to use it. */
  readonly photo: string | null;
}

interface Capture {
  /** The request being answered: the session's generation and the request's action. */
  readonly generation: number;
  readonly actionId: number;
  readonly question: string;
  readonly phase: ImageCapturePhase;
  /** The stored photo while it is reviewed; it becomes the answer only through `use`. */
  readonly reference: string | null;
}

export interface ImageCaptureHost {
  readonly session: ShallowRef<PlayerRuntimeSession | null>;
  readonly generation: Readonly<Ref<number>>;
  readonly camera: SessionCamera<MediaStreamTrack>;
  /** Changes whenever the camera may have opened, failed, ended, or been released. */
  readonly cameraRevision: Readonly<Ref<number>>;
  readonly media: CapturedMediaStore;
  /** Opens the camera for a capture, from the player's click; resolves to whether it can be used. */
  openCamera(): Promise<boolean>;
  /** Called when a capture ends, so a camera opened only for it can be released. */
  captureEnded(): void;
  /** Observes the current time, publishes the result, and returns the published session. */
  observe(): PlayerRuntimeSession | null;
  publish(session: PlayerRuntimeSession): void;
}

/**
 * The camera route of `askImage`: Player-only state, never runtime state, so a restored session starts again from the
 * source choice and never takes a photo by itself. A photo is stored as session media when it is taken, answers the
 * request only when the player uses it, and is dropped when the player takes another or the capture ends.
 */
export function useImageCapture(host: ImageCaptureHost) {
  const capture = shallowRef<Capture | null>(null);

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
    if (next === null && previous !== null) host.captureEnded();
  }

  /** Continues `target` with `change` while it is still the capture of the request it answers. */
  function update(target: Capture, change: Partial<Pick<Capture, "phase" | "reference">>) {
    if (capture.value !== target) {
      // Only a photo taken for a capture that is gone needs dropping.
      if (change.reference) host.media.discard(change.reference);
      return null;
    }
    const next = { ...target, ...change };
    set(next);
    return next;
  }

  async function openCamera(target: Capture) {
    const opened = await host.openCamera();
    update(target, { phase: opened && host.camera.available ? "live" : "unavailable" });
  }

  /** Opens the capture view for the presented request, from the camera button. */
  function open(): void {
    const request = presentedRequest(host.session.value);
    if (request === null || request.ui.kind !== "image" || capture.value !== null) return;
    const target: Capture = {
      generation: host.generation.value,
      actionId: request.actionId,
      question: request.ui.hint ?? "Take a photo",
      phase: "opening",
      reference: null,
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

  /** Takes the photo the player framed. */
  async function shutter(): Promise<void> {
    const target = capture.value;
    if (target?.phase !== "live") return;
    const taking = update(target, { phase: "taking" });
    if (!taking) return;
    const answer = await host.camera.answer();
    update(
      taking,
      answer.kind === "captured"
        ? { phase: "review", reference: answer.reference }
        : { phase: "unavailable" },
    );
  }

  /** Drops the photo and frames another. */
  function retake(): void {
    const target = capture.value;
    if (target?.phase === "review") update(target, { phase: "live", reference: null });
  }

  /** Answers the request with the photo, at the observed time. */
  function use(): void {
    const target = capture.value;
    if (target?.phase !== "review" || target.reference === null) return;
    const current = host.observe() ?? host.session.value;
    if (current === null || !answers(current, target)) return set(null);
    const result = answerPlayerRuntimeImage(current, target.reference, host.media);
    if (result?.outcome.kind === "completed") {
      // The photo is the answer now, so it stays.
      capture.value = { ...target, reference: null };
      set(null);
      host.publish(result.session);
    } else set(null);
  }

  /** Closes the capture view; the request waits for another answer. */
  function close(): void {
    set(null);
  }

  // A capture belongs to one request: when the request ends, is interrupted, or its session is replaced, it closes.
  watch([host.session, host.generation], ([current]) => {
    const target = capture.value;
    if (target !== null && !answers(current, target)) set(null);
  });

  const view = computed<ImageCaptureView | null>(() => {
    const target = capture.value;
    if (target === null) return null;
    void host.cameraRevision.value;
    const photo = target.reference === null ? null : host.media.resolve(target.reference);
    return {
      phase: target.phase,
      question: target.question,
      track: target.phase === "live" || target.phase === "taking" ? host.camera.previewTrack : null,
      photo: photo?.state === "ready" ? photo.url : null,
    };
  });

  return { view, open, retry, shutter, retake, use, close, end: () => set(null) };
}
