import { computed, ref, watch, type Ref } from "vue";
import { useEventListener } from "@vueuse/core";
import { createBrowserCaptureHost } from "../../../browser-capture.js";
import { CaptureDevice } from "../../../capture-device.js";
import {
  activePlayerRuntimeInteraction,
  playerRuntimeCameraView,
  type PlayerSession,
} from "../../../runtime-view.js";
import { SessionCamera, type PlayerDiagnostic } from "../../../session-camera.js";
import { playerNoticeKeys, playerNotices, type PlayerNotices } from "../../../notices.js";
import { IMAGE_SKIP_TEXT } from "../../../../src/image-input.js";
import { useCameraChoice } from "../stage/useCameraChoice";
import { useImageCapture } from "../stage/useImageCapture";
import { usePlayerTextPreference } from "../shell/usePlayerPreference";
import type { CapturedMediaStore } from "../../../captured-media.js";
import type { PlayerSessionOptions } from "./usePlayerSession.js";

/*
 * The Player's cameras, moved from `usePlayerSession` unchanged: the session camera, which `takePhoto()` and the
 * script's camera view use, and the image step's own camera; their choice, their reopening when the page is shown
 * again, their release when a session ends, and the image-capture composable. The session camera is made where the
 * composable made it (`useSessionCamera`), and the rest where its watchers were (`usePlayerCameraLifecycle`), so every
 * watcher registers in the order it did.
 */

/** What the session camera needs from the Player's session composable. */
interface SessionCameraHost {
  readonly capturedMedia: CapturedMediaStore;
  readonly reportDiagnostic: (diagnostic: PlayerDiagnostic) => void;
}

/** What the cameras' lifecycle needs from the Player's session composable. */
interface CameraLifecycleHost {
  readonly session: Readonly<Ref<PlayerSession | null>>;
  readonly servicedSession: Readonly<Ref<PlayerSession | null>>;
  readonly stopped: Readonly<Ref<boolean>>;
  readonly generation: Readonly<Ref<number>>;
  readonly notices: PlayerNotices;
  readonly capturedMedia: CapturedMediaStore;
  readonly camera: SessionCamera<MediaStreamTrack>;
  readonly cameraRevision: Ref<number>;
  readonly chosenCamera: Ref<string | null>;
  readonly options: PlayerSessionOptions;
}

export function useSessionCamera({ capturedMedia, reportDiagnostic }: SessionCameraHost) {
  // Changes whenever the session camera may have opened, failed, ended, or been released.
  const cameraRevision = ref(0);
  // The camera the player switched to; every camera the Player opens prefers it while the browser has it.
  const chosenCamera = usePlayerTextPreference("player-camera");
  const camera: SessionCamera<MediaStreamTrack> = new SessionCamera(
    new CaptureDevice(
      createBrowserCaptureHost((kind, state) => {
        if (kind !== "camera") return;
        if (state.status === "ended") camera.ended();
        cameraRevision.value++;
      }),
      capturedMedia,
    ),
    reportDiagnostic,
    { chosen: () => chosenCamera.value },
  );
  return { cameraRevision, chosenCamera, camera };
}

export function usePlayerCameraLifecycle({
  session,
  servicedSession,
  stopped,
  generation,
  notices,
  capturedMedia,
  camera,
  cameraRevision,
  chosenCamera,
  options,
}: CameraLifecycleHost) {
  // The script places the camera view with `showCamera [stage]` and hides it with `hideCamera`; the view only previews
  // the session camera, which stays open for `takePhoto()`. Without an available camera there is nothing to show.
  const viewfinderPlacement = computed(() => {
    const current = session.value;
    return current === null ? null : playerRuntimeCameraView(current.state);
  });
  const viewfinder = computed(() => {
    void cameraRevision.value;
    return viewfinderPlacement.value === null ? null : camera.previewTrack;
  });
  // A session that ended releases its camera.
  watch(
    () => session.value?.state.status,
    (status) => {
      if (status === "halted" || status === "failed") camera.release();
    },
  );

  // The camera step of `askImage` uses the session camera while it is open. Otherwise it opens a camera of its own, which
  // only that step uses and which is released when the step ends, so it never serves `takePhoto()` or a script's camera
  // view. Its problems show in the viewfinder itself.
  const cameraOffered =
    options.capabilities?.camera === true ||
    (typeof navigator !== "undefined" &&
      typeof navigator.mediaDevices?.getUserMedia === "function");
  const captureCamera: SessionCamera<MediaStreamTrack> = new SessionCamera(
    new CaptureDevice(
      createBrowserCaptureHost((kind, state) => {
        if (kind !== "camera") return;
        if (state.status === "ended") captureCamera.ended();
        cameraRevision.value++;
      }),
      capturedMedia,
    ),
    () => {},
    { chosen: () => chosenCamera.value },
  );
  // A phone's camera often stops while the page is in the background, as when another app takes it: once the page is
  // shown again, an open camera that ended or stays muted opens again.
  const cameraShown = () => {
    if (document.visibilityState === "hidden") return;
    camera.shown();
    captureCamera.shown();
  };
  useEventListener(
    () => (typeof document === "undefined" ? undefined : document),
    "visibilitychange",
    cameraShown,
  );
  useEventListener(
    () => (typeof window === "undefined" ? undefined : window),
    "pageshow",
    cameraShown,
  );
  const cameraChoice = useCameraChoice({
    cameras: [camera, captureCamera],
    revision: cameraRevision,
    chosen: chosenCamera,
  });
  const imageCapture = useImageCapture({
    // A session a Player error stopped takes no input, so its request's steps close.
    session: computed(() => (stopped.value ? null : servicedSession.value)),
    generation,
    sessionCamera: camera,
    captureCamera,
    cameraRevision,
    media: capturedMedia,
    offered: cameraOffered,
  });
  // An image request that allows only the camera cannot be answered with an image where no camera can be used; one the
  // player may skip says that Skip still answers it. Each such request, of a session and an action, is reported once, so
  // a dismissal holds only for the request it was given for.
  const cameraOnlyRequest = () => {
    const request = session.value && activePlayerRuntimeInteraction(session.value.state);
    return request?.ui.kind === "image" && !request.ui.allowFile && !cameraOffered ? request : null;
  };
  watch(
    () => {
      const request = cameraOnlyRequest();
      return request === null ? null : `${generation.value}:${request.actionId}`;
    },
    (reported) => {
      const request = cameraOnlyRequest();
      if (reported === null || request?.ui.kind !== "image")
        notices.dismiss(playerNoticeKeys.imageNeedsCamera);
      else
        notices.publish(
          playerNotices.imageNeedsCamera(request.ui.allowSkip ? IMAGE_SKIP_TEXT : null),
        );
    },
  );
  return {
    cameraOffered,
    captureCamera,
    cameraChoice,
    imageCapture,
    viewfinderPlacement,
    viewfinder,
  };
}
