import { useEventListener } from "@vueuse/core";
import { computed, ref, shallowRef, watch, type Ref } from "vue";
import { cameraFacing, nextCamera, switchCameraLabel } from "../../camera-choice.js";
import type { CaptureDeviceInfo } from "../../capture-device.js";
import type { SessionCamera } from "../../session-camera.js";

interface CameraChoiceHost {
  /** The Player's cameras; the view shows the first open one. */
  readonly cameras: readonly SessionCamera<MediaStreamTrack>[];
  /** Changes whenever a camera may have opened, failed, ended, or been released. */
  readonly revision: Readonly<Ref<number>>;
  /** The camera the player chose in this browser, or `null` for the browser's default camera. */
  readonly chosen: Ref<string | null>;
}

/**
 * The camera view's choices (PLAYER-UI "Stage and media presentation"). With two or more cameras, the switch opens the
 * next one in the browser's order, and the camera it opened is remembered in this browser. The view mirrors a camera
 * unless it faces back, as camera apps do, until the player flips it; another camera starts from its own default.
 */
export function useCameraChoice(host: CameraChoiceHost) {
  const shownCamera = () => host.cameras.find((camera) => camera.previewTrack !== null) ?? null;
  const shown = computed(() => {
    void host.revision.value;
    const settings = shownCamera()?.previewTrack?.getSettings();
    return settings === undefined
      ? null
      : { deviceId: settings.deviceId ?? "", facing: cameraFacing(settings.facingMode) };
  });

  // The browser names its cameras only once the player allowed one, so they are listed again whenever a camera opens,
  // and whenever the browser's devices change, as when a camera is plugged in.
  const listed = shallowRef<readonly CaptureDeviceInfo[]>([]);
  let listing = 0;
  async function list() {
    const camera = shownCamera();
    if (camera === null) return;
    const sequence = ++listing;
    const cameras = await camera.cameras();
    if (sequence === listing) listed.value = cameras;
  }
  watch(host.revision, () => void list());
  if (typeof navigator !== "undefined" && navigator.mediaDevices)
    useEventListener(navigator.mediaDevices, "devicechange", () => void list());
  const next = computed(() => shown.value && nextCamera(listed.value, shown.value.deviceId));

  const mirrored = ref(true);
  let mirroredCamera = "";
  watch(shown, (camera) => {
    if (camera === null || camera.deviceId === "" || camera.deviceId === mirroredCamera) return;
    mirroredCamera = camera.deviceId;
    mirrored.value = camera.facing !== "back";
  });

  async function switchCamera() {
    const camera = shownCamera();
    const to = next.value;
    if (camera === null || to === null || !(await camera.switchTo(to.deviceId))) return;
    const opened = camera.previewTrack?.getSettings().deviceId;
    if (opened) host.chosen.value = opened;
  }

  return {
    /** Whether the view shows its camera mirrored. */
    mirrored,
    /** The camera switch's name, or `null` without another camera to switch to. */
    switchLabel: computed(
      () => next.value && switchCameraLabel(cameraFacing(next.value.facingMode)),
    ),
    switchCamera,
  };
}
