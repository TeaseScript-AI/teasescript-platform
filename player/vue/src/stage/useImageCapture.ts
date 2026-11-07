import { computed, onScopeDispose, shallowRef, watch, type Ref } from "vue";
import type { CapturedMediaStore } from "../../../media/captured-media.js";
import type { DebugAnswerInput } from "../../../debug/debug-export.js";
import { heldMedia } from "../../../engine-bridge/held-media.js";
import {
  activePlayerRuntimeInteraction,
  type PlayerSession,
  type PlayerSessionView,
} from "../../../runtime/runtime-view.js";
import type { SessionCamera } from "../../../media/session-camera.js";
import type { InputIntent, InputOutcome } from "../session/runtime-input";

/**
 * Where an `askImage` request's Player controls stand: the first step, which offers the routes to an image and "Use
 * image", or the camera step with the camera opening, the live view the player frames the photo in, the self-timer's
 * countdown, the photo being taken, or a camera that cannot be used.
 */
export type ImageCapturePhase =
  "choose" | "opening" | "live" | "countdown" | "taking" | "unavailable";

/** The seconds the self-timer counts down before the photo. */
const COUNTDOWN_SECONDS = 5;

/** What the controls in the chat, the preview on the Stage, and the viewfinder show. */
export interface ImageCaptureView {
  readonly phase: ImageCapturePhase;
  /** Whether the request offers the camera here: it allows the camera, and a camera can be used. */
  readonly camera: boolean;
  /** The live camera during the camera step. */
  readonly track: MediaStreamTrack | null;
  /** Whether an image waits to answer the request, the preview of the first step. */
  readonly ready: boolean;
  /** The preview's address once it can be shown. */
  readonly preview: string | null;
  /** The seconds left before the photo is taken, during the self-timer's countdown. */
  readonly countdown: number | null;
}

interface Capture {
  /** The request being answered: the session's generation and the request's action. */
  readonly generation: number;
  readonly actionId: number;
  /** Whether the request offers the camera here. */
  readonly camera: boolean;
  readonly phase: ImageCapturePhase;
  /** The stored photo or file of the preview; it becomes the answer only through `answer`. */
  readonly reference: string | null;
  /** Whether the camera step uses the camera it opened itself rather than the session camera. */
  readonly own: boolean;
  readonly countdown: number | null;
}

export interface ImageCaptureHost {
  readonly session: Readonly<Ref<PlayerSession | null>>;
  readonly generation: Readonly<Ref<number>>;
  /** The session camera: the camera step uses it while it is open, and never opens or releases it. */
  readonly sessionCamera: SessionCamera<MediaStreamTrack>;
  /**
   * The camera the camera step opens itself while the session camera is not open. Only the camera step uses it, so it
   * never serves `takePhoto()` or a script's camera view, and it is released when the step ends.
   */
  readonly captureCamera: SessionCamera<MediaStreamTrack>;
  /** Changes whenever a camera may have opened, failed, ended, or been released. */
  readonly cameraRevision: Readonly<Ref<number>>;
  readonly media: CapturedMediaStore;
  /** Whether a camera can be used here at all; without it the request offers no camera. */
  readonly offered: boolean;
  /** Waits one step of the countdown; a second by default. */
  countdownStep?: () => Promise<void>;
}

/**
 * The Player's controls of a presented `askImage` request, in two steps. The first offers the camera, the file picker,
 * and "Use image", which alone answers the request with the preview: the last photo taken or file chosen. "Open camera"
 * leads to the camera step, which takes a photo at once or after the self-timer and returns to the first step with it.
 * The camera step uses the session camera while it is open, otherwise a camera it opens itself and turns off when it
 * returns. All of this is Player-only state, never runtime state, so a restored session starts at the first step
 * without a preview and never takes a photo by itself. A preview is stored as session media and dropped when another
 * replaces it or the request ends without it.
 */
export function useImageCapture(host: ImageCaptureHost) {
  const capture = shallowRef<Capture | null>(null);
  const cameraOf = (target: Capture) => (target.own ? host.captureCamera : host.sessionCamera);

  const presentedRequest = (current: PlayerSessionView | null) => {
    const action = current && activePlayerRuntimeInteraction(current.state);
    return action?.ui.kind === "image" ? action : null;
  };
  const answers = (current: PlayerSessionView | null, target: Capture) =>
    host.generation.value === target.generation &&
    presentedRequest(current)?.actionId === target.actionId;

  // The preview an answer took along, until that answer settled: it is not the capture's to discard meanwhile, as the
  // host may already have admitted it.
  let submitted: string | null = null;
  const discard = (reference: string) => {
    if (reference !== submitted) host.media.discard(reference);
  };

  function set(next: Capture | null) {
    const previous = capture.value;
    if (previous?.reference && previous.reference !== next?.reference) discard(previous.reference);
    capture.value = next;
    // A camera the camera step opened itself is released as soon as it no longer uses it.
    if (previous?.own && !next?.own) host.captureCamera.release();
  }

  /** Continues `target` with `change` while it is still the capture of the request it answers. */
  function update(
    target: Capture,
    change: Partial<Pick<Capture, "phase" | "reference" | "own" | "countdown">>,
  ) {
    if (capture.value !== target) {
      // Only a photo taken for a capture that is gone needs dropping.
      if (change.reference) discard(change.reference);
      return null;
    }
    const next = { ...target, ...change };
    set(next);
    return next;
  }

  /**
   * Makes the capture that of the presented request: one for a request that ended, was interrupted, or whose session
   * was replaced closes, and a presented request gets one at the first step. Returns it, or `null` without a request.
   */
  function sync(): Capture | null {
    const current = host.session.value;
    const target = capture.value;
    if (target !== null && answers(current, target)) return target;
    if (target !== null) set(null);
    const request = presentedRequest(current);
    if (request?.ui.kind !== "image") return null;
    const next: Capture = {
      generation: host.generation.value,
      actionId: request.actionId,
      camera: host.offered && request.ui.allowCamera,
      phase: "choose",
      reference: null,
      own: false,
      countdown: null,
    };
    set(next);
    return next;
  }

  /** Uses the session camera while it is open; otherwise opens the camera step's own camera. */
  async function connect(target: Capture) {
    if (host.sessionCamera.available) {
      update(target, { phase: "live", own: false });
      return;
    }
    const opening = update(target, { own: true });
    if (!opening) return;
    await host.captureCamera.open(true);
    update(opening, { phase: host.captureCamera.available ? "live" : "unavailable" });
  }

  /** Leads from the first step to the camera, from "Open camera". */
  function openCamera(): void {
    const target = sync();
    if (target?.phase !== "choose" || !target.camera) return;
    const next = update(target, { phase: "opening" });
    if (next) void connect(next);
  }

  /** Opens the camera again after it could not be used, from "Try again". */
  function retry(): void {
    const target = sync();
    if (target?.phase !== "unavailable") return;
    const next = update(target, { phase: "opening" });
    if (next) void connect(next);
  }

  /** Returns from the camera step to the first step without a new photo, from "Back". */
  function back(): void {
    const target = sync();
    if (target !== null && target.phase !== "choose")
      update(target, { phase: "choose", own: false, countdown: null });
  }

  // The countdown's waiting step, cleared when the Player unmounts so no step outlives it.
  let stepTimer: ReturnType<typeof setTimeout> | undefined;
  const countdownStep =
    host.countdownStep ??
    (() =>
      new Promise<void>((resolve) => {
        stepTimer = setTimeout(resolve, 1_000);
      }));

  /** Takes the photo the player framed and returns to the first step with it as the preview. */
  async function shoot(target: Capture): Promise<void> {
    const taking = update(target, { phase: "taking", countdown: null });
    if (!taking) return;
    const answer = await cameraOf(taking).answer();
    update(
      taking,
      answer.kind === "captured"
        ? { phase: "choose", reference: answer.reference, own: false }
        : { phase: "unavailable" },
    );
  }

  /** Takes the photo at once, from "Take photo". */
  async function takePhoto(): Promise<void> {
    const target = sync();
    if (target?.phase === "live") await shoot(target);
  }

  /** Counts down, then takes the photo, from "Self-timer"; a step that ends meanwhile takes none. */
  async function selfTimer(): Promise<void> {
    let target = sync();
    if (target?.phase !== "live") return;
    for (let count = COUNTDOWN_SECONDS; count > 0; count--) {
      const counting = update(target, { phase: "countdown", countdown: count });
      if (!counting) return;
      await countdownStep();
      target = counting;
    }
    await shoot(target);
  }

  /**
   * Makes an image file the player chose for the presented request its preview, also during the camera step, which then
   * returns to the first step. `false` when no request takes it, and the caller keeps the file.
   */
  function choose(reference: string): boolean {
    const target = sync();
    if (target === null) return false;
    update(target, { phase: "choose", reference, own: false, countdown: null });
    return true;
  }

  /**
   * "Use image": answers the observed session's request with the preview (the `answerImage` op), with what the store
   * holds it as; `null` without a preview to answer. Until the answer settled, the preview stays held, also when the
   * request ends meanwhile.
   */
  function answer(input: DebugAnswerInput): InputIntent {
    return (observed) => {
      const target = sync();
      if (target?.phase !== "choose" || target.reference === null || !answers(observed, target))
        return null;
      const reference = target.reference;
      submitted = reference;
      return {
        op: "answerImage",
        args: { reference, held: heldMedia(host.media, [reference]), input },
        settle: (outcome) => settle(reference, outcome),
      };
    };
  }
  /** Settles the answer with `reference`: the answer keeps it once it completed; otherwise it is the preview again. */
  function settle(reference: string, outcome: InputOutcome | null) {
    submitted = null;
    const target = capture.value;
    const still = target?.reference === reference;
    // The image is the answer now, so it stays.
    if (outcome?.kind === "completed") {
      if (still) capture.value = { ...target!, reference: null };
      return;
    }
    // Not taken: a preview the capture moved on from in the meantime goes.
    if (!still) host.media.discard(reference);
  }

  // A capture belongs to one request: when the request ends, however it was answered, is interrupted, or its session is
  // replaced, it closes, with its preview and a camera it opened; a presented request starts at the first step.
  watch([host.session, host.generation, capture], sync, { immediate: true });
  // A camera that ends while the player frames the photo, as when it is unplugged, offers "Try again".
  watch(host.cameraRevision, () => {
    const target = capture.value;
    if ((target?.phase === "live" || target?.phase === "countdown") && !cameraOf(target).available)
      update(target, { phase: "unavailable", countdown: null });
  });

  // When the Player unmounts, the capture ends: its preview is dropped and a camera it opened turns off.
  onScopeDispose(() => {
    clearTimeout(stepTimer);
    set(null);
  });

  const view = computed<ImageCaptureView | null>(() => {
    const target = capture.value;
    if (target === null) return null;
    void host.cameraRevision.value;
    const preview =
      target.reference === null ? null : host.media.resolve(target.reference, "image");
    return {
      phase: target.phase,
      camera: target.camera,
      track:
        target.phase === "live" || target.phase === "countdown" || target.phase === "taking"
          ? cameraOf(target).previewTrack
          : null,
      ready: target.reference !== null,
      preview: preview?.state === "ready" ? preview.url : null,
      countdown: target.countdown,
    };
  });

  return { view, openCamera, retry, back, takePhoto, selfTimer, choose, answer };
}

/** The controls of the presented `askImage` request, as the Player gives them to its interaction. */
export type ImageCapture = ReturnType<typeof useImageCapture>;
