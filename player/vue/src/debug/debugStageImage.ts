import { isCapturedMediaReference } from "../../../media/captured-media.js";
import {
  debugStageImageStatus,
  type DebugStageImageStatus,
} from "../../../presentation/presentation.js";
import { playerRuntimeMedia, type PlayerSession } from "../../../runtime/runtime-view.js";
import type { PlayerSessionHost } from "../session/usePlayerSession";

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
    /** The session whose Stage this describes; the Player's shown session by default. */
    readonly session?: PlayerSession | null;
  },
): {
  readonly status: DebugStageImageStatus;
  readonly path: string | null;
  readonly captured: boolean;
} {
  // The image and video are the described session's; the load reports describe the browser as it is now.
  const session = shown.session === undefined ? player.session.value : shown.session;
  const stage = session === null ? null : playerRuntimeMedia(session.state).stage;
  const image = stage?.image ?? null;
  const observed = player.stageImageObservation.value;
  const video = stage?.videoMediaId ?? null;
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
