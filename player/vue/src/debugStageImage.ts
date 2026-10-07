import { isCapturedMediaReference } from "../../captured-media.js";
import { debugStageImageStatus, type DebugStageImageStatus } from "../../presentation.js";
import { playerRuntimeMedia } from "../../runtime-adapter.js";
import type { PlayerSessionHost } from "./usePlayerSession";

/**
 * The Stage image as Debug's Now view and the debug export report it: its status from the session's Stage and the
 * Stage's own load reports, and its authored path; a captured or chosen image has no path.
 */
export function debugStageImage(
  player: PlayerSessionHost,
  shown: {
    /** Whether the camera view covers the Stage image. */
    readonly covered: boolean;
    /** Whether the development preview shows a Stage media fixture instead of the session's image. */
    readonly overridden: boolean;
  },
): {
  readonly status: DebugStageImageStatus;
  readonly path: string | null;
  readonly captured: boolean;
} {
  const image = player.stageImage.value;
  const observed = player.stageImageObservation.value;
  const session = player.session.value;
  const video = session === null ? null : playerRuntimeMedia(session.state).stage.videoMediaId;
  const captured = image !== null && isCapturedMediaReference(image);
  return {
    status: debugStageImageStatus({
      image,
      source: image === null ? null : player.resolveAsset(image),
      overridden: shown.overridden,
      covered: shown.covered || video !== null,
      loaded: observed.loaded,
      failed: observed.failed,
    }),
    path: image === null || captured ? null : image,
    captured,
  };
}
