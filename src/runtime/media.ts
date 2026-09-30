import type { SerializableRuntimeValue } from "./serializable-values.js";

/**
 * Audio or video playback state. The enclosing background action owns an ADR 0016 action ID; the media ID is the
 * identity behind opaque handles. The engine owns lifecycle, passes, repeat limits, cue order, and settlement; the
 * Player reports only load results and scene-timestamped playback progress. Settled records remain so handles stay
 * readable.
 */
export type RuntimeMediaState = "running" | "paused" | "finished" | "stopped";

export type RuntimeMediaRepeatSnapshot =
  | { readonly kind: "once" }
  | { readonly kind: "indefinite" }
  /** Total passes of the active range. */
  | { readonly kind: "count"; readonly passes: number }
  /** Active playback time after which playback finishes, even mid-pass. */
  | { readonly kind: "budget"; readonly milliseconds: number };

/** A cue with its evaluated offset. `at` is a source position; `beforeEnd` is measured back from the active end. */
export interface RuntimeMediaCueSnapshot {
  readonly kind: "at" | "beforeEnd";
  readonly offsetMs: number;
  readonly functionId: number;
}

/**
 * One Player progress sample of the current segment: at scene time `atMs` the segment had played `progressMs`.
 * Samples increase strictly in time and never decrease in progress; equal progress records a stall.
 */
export interface RuntimeMediaPointSnapshot {
  readonly atMs: number;
  readonly progressMs: number;
}

export interface RuntimeMediaSnapshot {
  readonly mediaId: number;
  readonly media: "audio" | "video";
  readonly source: string;
  state: RuntimeMediaState;
  /** Whether the Player reported the source as loaded. Duration-dependent values are authoritative only then. */
  loaded: boolean;
  /** Source duration reported by the Player; `null` until loaded. */
  durationMs: number | null;
  readonly startAtMs: number;
  /** Requested end of the active range; the effective end is limited to the source duration. */
  readonly endAtMs: number | null;
  volume: number;
  readonly repeat: RuntimeMediaRepeatSnapshot;
  /** In source order; a compact block is a `beforeEnd` cue at offset zero. */
  readonly cues: readonly RuntimeMediaCueSnapshot[];
  readonly finishFunctionId: number | null;
  /** Playback segment; every canonical timeline change starts a new one. Player progress reports name it. */
  segment: number;
  /** Segment progress up to which timeline events are committed. */
  committedProgressMs: number;
  /** Playhead at the committed progress (or where paused or settled). */
  positionMs: number;
  /** Active playback at the committed progress, across passes; seeks and pauses do not add to it. */
  elapsedMs: number;
  /** Completed passes at the committed progress. */
  passesCompleted: number;
  /** Cues at the current start position fire once playback proceeds from it (after load, seek, or a pass wrap). */
  startCuesPending: boolean;
  /** Samples of the current segment; the first is the segment's anchor or the last sample before current time. */
  points: RuntimeMediaPointSnapshot[];
}

export interface MediaWarning {
  readonly code: "TSW010";
  readonly message: string;
}

/**
 * A queued media cue block, sharing the interrupt queue with timer expiry blocks. Consecutive invocations of the same
 * block for the same media share one entry.
 */
export interface RuntimeMediaCueInvocationSnapshot {
  readonly mediaId: number;
  readonly handlerFunctionId: number;
  readonly dueAtMs: number;
  count: number;
}

/**
 * The next timeline event. An arrival is reached when playback reaches segment progress `progressMs`; a departure
 * happens when playback proceeds from the committed position and is ordered after other work at the same time.
 */
export interface MediaTimelineEvent {
  readonly kind: "arrival" | "departure";
  readonly progressMs: number;
  /** The playhead the event reaches; for a departure, the position it leaves. */
  readonly positionMs: number;
  /** Scene time of the event once reported progress covers it; otherwise `null`. */
  readonly dueAtMs: number | null;
}

/** What committing one event did, so the caller can queue blocks and settle. */
export interface MediaEventOutcome {
  /** Cue blocks to queue, in source order. */
  readonly cueFunctionIds: readonly number[];
  readonly finished: boolean;
}

export function isActiveMedia(media: RuntimeMediaSnapshot): boolean {
  return media.state === "running" || media.state === "paused";
}

/** The effective end of the active range; only meaningful once loaded. */
export function mediaEndMs(media: RuntimeMediaSnapshot): number {
  const duration = media.durationMs ?? 0;
  return media.endAtMs === null ? duration : Math.min(media.endAtMs, duration);
}

/** Cue point in the source; `beforeEnd` is relative to the effective end. */
export function mediaCuePointMs(media: RuntimeMediaSnapshot, cue: RuntimeMediaCueSnapshot): number {
  return cue.kind === "at" ? cue.offsetMs : mediaEndMs(media) - cue.offsetMs;
}

function inRange(media: RuntimeMediaSnapshot, point: number): boolean {
  return point >= media.startAtMs && point <= mediaEndMs(media);
}

/** Function IDs of the cues exactly at `point`, in source order; points outside the active range never fire. */
function cuesAt(media: RuntimeMediaSnapshot, point: number): number[] {
  if (!inRange(media, point)) return [];
  return media.cues
    .filter((cue) => mediaCuePointMs(media, cue) === point)
    .map((cue) => cue.functionId);
}

/** The nearest cue point after `from` inside the active range, or `null`. */
function nextCuePointAfter(media: RuntimeMediaSnapshot, from: number): number | null {
  let next: number | null = null;
  for (const cue of media.cues) {
    const point = mediaCuePointMs(media, cue);
    if (point > from && inRange(media, point) && (next === null || point < next)) next = point;
  }
  return next;
}

function budgetLeftMs(media: RuntimeMediaSnapshot): number {
  return media.repeat.kind === "budget"
    ? Math.max(0, media.repeat.milliseconds - media.elapsedMs)
    : Infinity;
}

/** Whether another pass follows the one that just completed (`passesCompleted` already counts it). */
function anotherPass(media: RuntimeMediaSnapshot): boolean {
  switch (media.repeat.kind) {
    case "once":
      return false;
    case "indefinite":
      return true;
    case "count":
      return media.passesCompleted < media.repeat.passes;
    case "budget":
      return budgetLeftMs(media) > 0;
  }
}

/** Where the next arrival lies: the next cue point, the end of the pass, or the end of a repeat budget. */
function nextArrival(media: RuntimeMediaSnapshot): { progressMs: number; positionMs: number } {
  const end = mediaEndMs(media);
  const from = media.positionMs;
  const target = from >= end ? end : (nextCuePointAfter(media, from) ?? end);
  const progressMs = media.committedProgressMs + (target - from);
  const budgetEnd = media.committedProgressMs + budgetLeftMs(media);
  return budgetEnd < progressMs
    ? { progressMs: budgetEnd, positionMs: from + (budgetEnd - media.committedProgressMs) }
    : { progressMs, positionMs: target };
}

/** Interpolated scene times and progress are canonical in whole milliseconds. */
function roundMs(value: number): number {
  return Math.round(value);
}

/** Scene time at which reported playback reached `progressMs`, or `null` if not yet. */
function arrivalTime(
  points: readonly RuntimeMediaPointSnapshot[],
  progressMs: number,
): number | null {
  const index = points.findIndex((point) => point.progressMs >= progressMs);
  if (index < 0) return null;
  const after = points[index]!;
  if (index === 0 || after.progressMs === progressMs) return after.atMs;
  const before = points[index - 1]!;
  return roundMs(
    before.atMs +
      ((progressMs - before.progressMs) * (after.atMs - before.atMs)) /
        (after.progressMs - before.progressMs),
  );
}

/**
 * Scene time at which reported playback proceeded beyond `progressMs`: the right edge of a stall at that progress, or
 * the arrival time when playback passed it without stopping; `null` if not yet.
 */
function departureTime(
  points: readonly RuntimeMediaPointSnapshot[],
  progressMs: number,
): number | null {
  if (!points.some((point) => point.progressMs > progressMs)) return null;
  let last = -1;
  for (let index = 0; index < points.length; index += 1) {
    if (points[index]!.progressMs <= progressMs) last = index;
  }
  if (last >= 0 && points[last]!.progressMs === progressMs) return points[last]!.atMs;
  return arrivalTime(points, progressMs);
}

/** Reported segment progress at scene time `atMs`, interpolated and rounded; never extrapolated. */
function progressAt(points: readonly RuntimeMediaPointSnapshot[], atMs: number): number {
  let index = -1;
  for (let candidate = 0; candidate < points.length; candidate += 1) {
    if (points[candidate]!.atMs <= atMs) index = candidate;
  }
  if (index < 0) return points[0]?.progressMs ?? 0;
  const before = points[index]!;
  const after = points[index + 1];
  if (after === undefined) return before.progressMs;
  return roundMs(
    before.progressMs +
      ((atMs - before.atMs) * (after.progressMs - before.progressMs)) / (after.atMs - before.atMs),
  );
}

/**
 * The next event of loaded media, with its due time when reported progress covers it. Paused media at the end of its
 * range still completes that pass, which a seek to the end requested.
 */
export function nextMediaEvent(media: RuntimeMediaSnapshot): MediaTimelineEvent | null {
  if (!media.loaded || !isActiveMedia(media)) return null;
  const atEnd = media.positionMs >= mediaEndMs(media);
  if (media.state === "paused") {
    return atEnd
      ? {
          kind: "arrival",
          progressMs: media.committedProgressMs,
          positionMs: media.positionMs,
          dueAtMs: media.points[0]!.atMs,
        }
      : null;
  }
  if (media.startCuesPending && !atEnd) {
    return {
      kind: "departure",
      progressMs: media.committedProgressMs,
      positionMs: media.positionMs,
      dueAtMs: departureTime(media.points, media.committedProgressMs),
    };
  }
  const arrival = nextArrival(media);
  return {
    kind: "arrival",
    progressMs: arrival.progressMs,
    positionMs: arrival.positionMs,
    dueAtMs: arrivalTime(media.points, arrival.progressMs),
  };
}

/**
 * Commits one event: a departure fires the cues at the start position; an arrival reaches its position, fires the cues
 * there, and at the end of the range completes the pass (restarting at `startAt` or finishing), or finishes when a
 * repeat budget ends there.
 */
export function commitMediaEvent(
  media: RuntimeMediaSnapshot,
  event: MediaTimelineEvent,
): MediaEventOutcome {
  if (event.kind === "departure") {
    media.startCuesPending = false;
    return { cueFunctionIds: cuesAt(media, media.positionMs), finished: false };
  }
  media.elapsedMs += event.progressMs - media.committedProgressMs;
  media.committedProgressMs = event.progressMs;
  media.positionMs = event.positionMs;
  const cueFunctionIds = cuesAt(media, media.positionMs);
  if (media.positionMs >= mediaEndMs(media)) {
    media.passesCompleted += 1;
    if (anotherPass(media)) {
      media.positionMs = media.startAtMs;
      media.startCuesPending = cuesAt(media, media.startAtMs).length > 0;
      return { cueFunctionIds, finished: false };
    }
    media.state = "finished";
    return { cueFunctionIds, finished: true };
  }
  if (budgetLeftMs(media) <= 0) {
    media.state = "finished";
    return { cueFunctionIds, finished: true };
  }
  return { cueFunctionIds, finished: false };
}

/** Segment progress at scene time `atMs`, never beyond the next uncommitted arrival. */
function progressBefore(media: RuntimeMediaSnapshot, atMs: number): number {
  if (media.state !== "running" || !media.loaded) return media.committedProgressMs;
  const reported = Math.max(media.committedProgressMs, progressAt(media.points, atMs));
  return Math.min(reported, nextArrival(media).progressMs);
}

/**
 * Starts a new segment at scene time `atMs` from the position playback reached by then. The caller has committed the
 * events due by then.
 */
function startSegment(media: RuntimeMediaSnapshot, atMs: number): void {
  const progress = progressBefore(media, atMs);
  // Playback that reached a cue point whose turn has not come yet at this scene time leaves those cues pending.
  if (
    progress > media.committedProgressMs &&
    progress === nextArrival(media).progressMs &&
    media.positionMs + (progress - media.committedProgressMs) < mediaEndMs(media)
  ) {
    media.startCuesPending =
      cuesAt(media, media.positionMs + (progress - media.committedProgressMs)).length > 0;
  }
  media.positionMs += progress - media.committedProgressMs;
  media.elapsedMs += progress - media.committedProgressMs;
  media.segment += 1;
  media.committedProgressMs = 0;
  media.points = [{ atMs, progressMs: 0 }];
}

/** Records the Player's load result at scene time `atMs`. Returns a warning message when the range is empty. */
export function loadMedia(
  media: RuntimeMediaSnapshot,
  durationMs: number,
  atMs: number,
): string | null {
  media.loaded = true;
  media.durationMs = durationMs;
  if (media.startAtMs >= mediaEndMs(media)) {
    media.state = "stopped";
    return `Media "${media.source}" has no playback range: startAt is not before the end of the ${durationMs} ms source.`;
  }
  media.positionMs = media.startAtMs;
  media.startCuesPending = cuesAt(media, media.startAtMs).length > 0;
  media.segment += 1;
  media.committedProgressMs = 0;
  media.points = [{ atMs, progressMs: 0 }];
  return null;
}

/**
 * Accepts one Player progress sample for the current segment. Samples of another segment, earlier or equal times, and
 * decreasing progress are ignored.
 */
export function recordMediaProgress(
  media: RuntimeMediaSnapshot,
  segment: number,
  progressMs: number,
  atMs: number,
): boolean {
  if (media.state !== "running" || !media.loaded || segment !== media.segment) return false;
  const last = media.points.at(-1)!;
  if (!(atMs > last.atMs) || progressMs < last.progressMs) return false;
  media.points.push({ atMs, progressMs });
  return true;
}

/** Keeps only the last sample at or before `atMs` and the later ones; earlier samples are no longer needed. */
export function pruneMediaPoints(media: RuntimeMediaSnapshot, atMs: number): void {
  let keepFrom = 0;
  for (let index = 1; index < media.points.length; index += 1) {
    if (media.points[index]!.atMs <= atMs) keepFrom = index;
  }
  if (keepFrom > 0) media.points.splice(0, keepFrom);
}

export function pauseMedia(media: RuntimeMediaSnapshot, atMs: number): MediaWarning | null {
  if (media.state === "paused") return null;
  if (media.state !== "running") return settledWarning(media, "pause()");
  startSegment(media, atMs);
  media.state = "paused";
  return null;
}

export function resumeMedia(media: RuntimeMediaSnapshot, atMs: number): MediaWarning | null {
  if (media.state === "running") return null;
  if (media.state !== "paused") return settledWarning(media, "resume()");
  startSegment(media, atMs);
  media.state = "running";
  return null;
}

/** Stops playback where it stands at `atMs`; `finish` does not run. */
export function stopMedia(media: RuntimeMediaSnapshot, atMs: number): void {
  if (!isActiveMedia(media)) return;
  if (media.loaded) startSegment(media, atMs);
  media.state = "stopped";
}

/**
 * Seeks to `requestedMs`, clamped to the active range. Cues strictly between the old and new position do not fire; cues
 * at the new position fire once playback proceeds from it, and a seek to the end completes the pass at once.
 */
export function seekMedia(
  media: RuntimeMediaSnapshot,
  requestedMs: number,
  atMs: number,
  operation: "position" | "remaining",
): MediaWarning | null {
  if (!isActiveMedia(media)) return settledWarning(media, operation);
  startSegment(media, atMs);
  const end = mediaEndMs(media);
  media.positionMs = Math.min(Math.max(requestedMs, media.startAtMs), end);
  media.startCuesPending = media.positionMs < end && cuesAt(media, media.positionMs).length > 0;
  return null;
}

export function setMediaVolume(media: RuntimeMediaSnapshot, volume: number): MediaWarning | null {
  if (!isActiveMedia(media)) return settledWarning(media, "volume");
  media.volume = volume;
  return null;
}

/** Handle property reads at scene time `atMs`; `undefined` means the property does not exist. */
export function mediaProperty(
  media: RuntimeMediaSnapshot,
  name: string,
  atMs: number,
): SerializableRuntimeValue | undefined {
  const duration = (milliseconds: number): SerializableRuntimeValue => ({
    kind: "duration",
    milliseconds,
  });
  const advanced = progressBefore(media, atMs) - media.committedProgressMs;
  switch (name) {
    case "position":
      return duration(media.positionMs + advanced);
    case "elapsed":
      return duration(media.elapsedMs + advanced);
    case "remaining":
      if (!media.loaded) return null;
      return duration(
        isActiveMedia(media) ? Math.max(0, mediaEndMs(media) - media.positionMs - advanced) : 0,
      );
    case "duration":
      return media.durationMs === null ? null : duration(media.durationMs);
    case "volume":
      return media.volume;
    case "state":
      return media.state;
    default:
      return undefined;
  }
}

/**
 * Segment progress at which playback ends, or `null` when it repeats indefinitely. A Player stops audible playback
 * there; the runtime settles only through its own timeline.
 */
export function mediaTerminalProgressMs(media: RuntimeMediaSnapshot): number | null {
  if (!media.loaded || !isActiveMedia(media) || media.repeat.kind === "indefinite") return null;
  const end = mediaEndMs(media);
  const toEnd = end - media.positionMs;
  const base = media.committedProgressMs;
  switch (media.repeat.kind) {
    case "once":
      return base + toEnd;
    case "count":
      return (
        base +
        toEnd +
        Math.max(0, media.repeat.passes - media.passesCompleted - 1) * (end - media.startAtMs)
      );
    case "budget":
      return base + budgetLeftMs(media);
  }
}

/**
 * Where the Player's playhead stands after all reported progress of the current segment: the source position that
 * reported progress reaches, following pass wraps and stopping at the terminal progress. A restored Player resumes
 * audible playback there.
 */
export function mediaPlayheadMs(media: RuntimeMediaSnapshot): number {
  if (!media.loaded || media.state !== "running") return media.positionMs;
  const terminal = mediaTerminalProgressMs(media);
  const reported = media.points.at(-1)!.progressMs;
  const pending =
    (terminal === null ? reported : Math.min(reported, terminal)) - media.committedProgressMs;
  const end = mediaEndMs(media);
  const toEnd = end - media.positionMs;
  if (pending < toEnd) return media.positionMs + pending;
  const passLength = end - media.startAtMs;
  const beyond = pending - toEnd;
  // Playback that ends exactly at the end of a pass stays at that end rather than wrapping.
  if (
    terminal !== null &&
    terminal - media.committedProgressMs === pending &&
    beyond % passLength === 0
  ) {
    return end;
  }
  return media.startAtMs + (beyond % passLength);
}

function settledWarning(media: RuntimeMediaSnapshot, operation: string): MediaWarning {
  return {
    code: "TSW010",
    message: `Media ${operation} has no effect because the media is already ${media.state}.`,
  };
}

export function cloneMedia(media: RuntimeMediaSnapshot): RuntimeMediaSnapshot {
  return {
    ...media,
    repeat: { ...media.repeat },
    cues: media.cues.map((cue) => ({ ...cue })),
    points: media.points.map((point) => ({ ...point })),
  };
}
