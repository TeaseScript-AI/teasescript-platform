import {
  mediaEndMs,
  mediaPlayheadMs,
  mediaTerminalProgressMs,
  type RuntimeMediaSnapshot,
} from "./media.js";
import type { RuntimeSnapshot } from "./state.js";

/**
 * What a Player needs to play one active media instance. It follows this projection rather than browser callbacks:
 * it loads `source` and reports the result; on a new `segment` it (re)positions to `playheadMs` and reports progress 0
 * when it starts; it plays the active range from `playheadMs`, wrapping from `endMs` to `startAtMs` until reported
 * progress reaches `terminalProgressMs`; and it reports the segment's active playback time, excluding stalls and
 * pauses, with each time observation.
 */
export interface MediaPlaybackProjection {
  readonly mediaId: number;
  readonly media: "audio" | "video";
  readonly source: string;
  readonly state: "running" | "paused";
  /** `false` until the Player reports the load result. */
  readonly loaded: boolean;
  readonly volume: number;
  readonly segment: number;
  readonly startAtMs: number;
  /** Effective end of the active range; `null` until loaded. */
  readonly endMs: number | null;
  /** Latest reported progress of the current segment; a restored Player continues counting from here. */
  readonly reportedProgressMs: number;
  /** Source position that the reported progress reaches; playback resumes here. */
  readonly playheadMs: number;
  /** Segment progress at which playback ends; `null` when it repeats indefinitely or is not loaded. */
  readonly terminalProgressMs: number | null;
}

export interface StageProjection {
  /** The persistent Stage image, or `null` for an empty Stage. */
  readonly image: string | null;
  /** The active video occupying the Stage over the image, if any. */
  readonly videoMediaId: number | null;
}

/** Active media in creation order. Settled media are not played. */
export function mediaPlaybackProjection(
  snapshot: RuntimeSnapshot,
): readonly MediaPlaybackProjection[] {
  const projections: MediaPlaybackProjection[] = [];
  for (const action of snapshot.backgroundActions) {
    if (action.kind !== "media") continue;
    projections.push(projectMedia(action.media));
  }
  return Object.freeze(projections);
}

export function stageProjection(snapshot: RuntimeSnapshot): StageProjection {
  const video = snapshot.backgroundActions.find(
    (action) => action.kind === "media" && action.media.media === "video",
  );
  return Object.freeze({
    image: snapshot.stageImage,
    videoMediaId: video?.kind === "media" ? video.media.mediaId : null,
  });
}

function projectMedia(media: RuntimeMediaSnapshot): MediaPlaybackProjection {
  if (media.state !== "running" && media.state !== "paused") {
    throw new Error("Only active media is projected for playback.");
  }
  return Object.freeze({
    mediaId: media.mediaId,
    media: media.media,
    source: media.source,
    state: media.state,
    loaded: media.loaded,
    volume: media.volume,
    segment: media.segment,
    startAtMs: media.startAtMs,
    endMs: media.loaded ? mediaEndMs(media) : null,
    reportedProgressMs: media.points.at(-1)?.progressMs ?? 0,
    playheadMs: mediaPlayheadMs(media),
    terminalProgressMs: mediaTerminalProgressMs(media),
  });
}
