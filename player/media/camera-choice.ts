/** Which way a camera faces, where the browser reports it. */
export type CameraFacing = "front" | "back";

/** The facing a browser's `facingMode` names; `null` for none, or a camera facing sideways. */
export function cameraFacing(facingMode: string | undefined): CameraFacing | null {
  return facingMode === "user" ? "front" : facingMode === "environment" ? "back" : null;
}

/**
 * The camera after the camera `current` in the browser's list, wrapping around, so a phone flips between its front and
 * back cameras and more cameras take turns; the first camera when `current` is not listed. `null` with fewer than two.
 */
export function nextCamera<Camera extends { readonly deviceId: string }>(
  cameras: readonly Camera[],
  current: string,
): Camera | null {
  if (cameras.length < 2) return null;
  const index = cameras.findIndex((camera) => camera.deviceId === current);
  return cameras[(index + 1) % cameras.length] ?? null;
}

/** The camera switch's name: which camera it switches to, where the browser reports which way that one faces. */
export function switchCameraLabel(next: CameraFacing | null): string {
  return next === null ? "Switch camera" : `Switch to ${next} camera`;
}
