import { formatDuration } from "../duration.js";
import { interpolateCeilMs, interpolateRoundMs } from "./exact-interpolation.js";
import type { SerializableRuntimeValue } from "./serializable-values.js";
import { cloneCaptures, type RuntimeCaptureSnapshot } from "./captures.js";

/**
 * Audio or video playback state. The enclosing background action owns an ADR 0016 action ID; the media ID is the
 * identity behind opaque handles. The engine owns lifecycle, passes, repeat limits, cue order, and settlement; the
 * Player reports only load results and scene-timestamped playback progress. A settled record keeps only what a handle
 * still reads.
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
  /** The activation root its cue and finish blocks run in; `null` without blocks. */
  readonly handlerRootScopeId: number | null;
  /** The variables its blocks share with the code that played it. */
  readonly captures: readonly RuntimeCaptureSnapshot[];
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
  /**
   * Position, completed passes, and total playback where the current segment started. Every segment progress the
   * timeline waits for is calculated from them by one formula, so it equals the terminal progress given to the Player.
   */
  segmentPositionMs: number;
  segmentPasses: number;
  segmentElapsedMs: number;
  /** Cues at the current start position fire once playback proceeds from it (after load, seek, or a pass wrap). */
  startCuesPending: boolean;
  /** Samples of the current segment; the first is the segment's anchor or the last sample before current time. */
  points: RuntimeMediaPointSnapshot[];
}

/**
 * What a handle still reads once media finished or stopped: its source, state, duration, volume, and where playback
 * ended. Nothing plays it again, so the timeline, blocks, and samples go when it settles.
 */
export interface RuntimeSettledMediaSnapshot {
  readonly mediaId: number;
  readonly source: string;
  readonly state: "finished" | "stopped";
  /** Source duration; `null` when the source never loaded. */
  readonly durationMs: number | null;
  readonly volume: number;
  readonly positionMs: number;
  readonly elapsedMs: number;
}

/** The parts of a media record that determine its timeline: range, repeat, cues, and the current segment's anchor. */
export type MediaTimeline = Pick<
  RuntimeMediaSnapshot,
  | "durationMs"
  | "startAtMs"
  | "endAtMs"
  | "repeat"
  | "cues"
  | "segmentPositionMs"
  | "segmentPasses"
  | "segmentElapsedMs"
>;

/** A timeline with its committed cursor. */
export type MediaCursor = MediaTimeline &
  Pick<RuntimeMediaSnapshot, "positionMs" | "committedProgressMs" | "passesCompleted">;

/** A committed cursor with its pending start cues, as persisted. */
export type PersistedMediaCursor = MediaCursor & Pick<RuntimeMediaSnapshot, "startCuesPending">;

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
  /** The activation root of its media's blocks. */
  readonly rootScopeId: number;
  /** Its media's shared variables, which the queued block keeps even when the media goes. */
  readonly captures: readonly RuntimeCaptureSnapshot[];
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

/** The record a media handle refers to: the active one, or what remains once the media settled. */
export type MediaHandleRecord = RuntimeMediaSnapshot | RuntimeSettledMediaSnapshot;

export function isActiveMedia(media: RuntimeMediaSnapshot): boolean {
  return media.state === "running" || media.state === "paused";
}

/** The settled record of finished or stopped media. */
export function settledMediaRecord(media: RuntimeMediaSnapshot): RuntimeSettledMediaSnapshot {
  if (media.state !== "finished" && media.state !== "stopped") {
    throw new Error("Only finished or stopped media can settle.");
  }
  return {
    mediaId: media.mediaId,
    source: media.source,
    state: media.state,
    durationMs: media.durationMs,
    volume: media.volume,
    positionMs: media.positionMs,
    elapsedMs: media.elapsedMs,
  };
}

/** The effective end of the active range; only meaningful once loaded. */
export function mediaEndMs(media: MediaTimeline): number {
  const duration = media.durationMs ?? 0;
  return media.endAtMs === null ? duration : Math.min(media.endAtMs, duration);
}

/** Cue point in the source; `beforeEnd` is relative to the effective end. */
export function mediaCuePointMs(media: MediaTimeline, cue: RuntimeMediaCueSnapshot): number {
  return cue.kind === "at" ? cue.offsetMs : mediaEndMs(media) - cue.offsetMs;
}

function inRange(media: MediaTimeline, point: number): boolean {
  return point >= media.startAtMs && point <= mediaEndMs(media);
}

/** Function IDs of the cues exactly at `point`, in source order; points outside the active range never fire. */
function cuesAt(media: MediaTimeline, point: number): number[] {
  if (!inRange(media, point)) return [];
  return media.cues
    .filter((cue) => mediaCuePointMs(media, cue) === point)
    .map((cue) => cue.functionId);
}

/** The nearest cue point after `from` inside the active range, or `null`. */
function nextCuePointAfter(media: MediaTimeline, from: number): number | null {
  let next: number | null = null;
  for (const cue of media.cues) {
    const point = mediaCuePointMs(media, cue);
    if (point > from && inRange(media, point) && (next === null || point < next)) next = point;
  }
  return next;
}

/**
 * Segment progress at which playback reaches `positionMs` in the pass after `passes` completed ones. Arrivals and the
 * terminal progress use only this calculation, never accumulated sums, so equal points compare equal exactly.
 */
function progressTo(media: MediaTimeline, positionMs: number, passes: number): number {
  return segmentProgressMs(
    passes - media.segmentPasses,
    mediaEndMs(media) - media.startAtMs,
    positionMs - media.segmentPositionMs,
  );
}

/** The anchor formula: whole passes since the anchor, then the distance within one. */
function segmentProgressMs(passes: number, passLengthMs: number, distanceMs: number): number {
  return passes * passLengthMs + distanceMs;
}

/**
 * Where a repeat duration ending at `endProgressMs` stands, measured back from the target its stretch heads to, which
 * playback reaches at `targetProgressMs`; nearby coordinates keep it stable.
 */
function durationTailPositionMs(
  targetMs: number,
  targetProgressMs: number,
  endProgressMs: number,
): number {
  return targetMs - (targetProgressMs - endProgressMs);
}

/** Segment progress at which a repeat duration is used up; unlimited for other repeat forms. */
function budgetEndProgressMs(media: MediaTimeline): number {
  return media.repeat.kind === "budget"
    ? media.repeat.milliseconds - media.segmentElapsedMs
    : Infinity;
}

/** Total playback at segment progress `progressMs`; a used-up repeat duration is exactly its length. */
function elapsedAt(media: RuntimeMediaSnapshot, progressMs: number): number {
  if (media.repeat.kind !== "budget") return media.segmentElapsedMs + progressMs;
  return progressMs >= budgetEndProgressMs(media)
    ? media.repeat.milliseconds
    : Math.min(media.repeat.milliseconds, media.segmentElapsedMs + progressMs);
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
      return media.committedProgressMs < budgetEndProgressMs(media);
  }
}

/** Where the next arrival lies: the next cue point, the end of the pass, or the end of a repeat budget. */
function nextArrival(media: MediaCursor): { progressMs: number; positionMs: number } {
  const end = mediaEndMs(media);
  const from = media.positionMs;
  const target = from >= end ? end : (nextCuePointAfter(media, from) ?? end);
  const progressMs = Math.max(
    media.committedProgressMs,
    progressTo(media, target, media.passesCompleted),
  );
  const budgetEnd = Math.max(media.committedProgressMs, budgetEndProgressMs(media));
  // A repeat duration ending before the target ends inside this stretch; rounding never carries it outside.
  return budgetEnd < progressMs
    ? {
        progressMs: budgetEnd,
        positionMs: Math.max(
          from,
          Math.min(
            target,
            durationTailPositionMs(
              target,
              progressTo(media, target, media.passesCompleted),
              budgetEnd,
            ),
          ),
        ),
      }
    : { progressMs, positionMs: target };
}

/**
 * Where the pass after `passes` completed ones starts in the current segment: at the anchor in the segment's first
 * pass, otherwise at the range start, reached when the pass before ended.
 */
function passOrigin(
  media: MediaTimeline,
  passes: number,
): { readonly positionMs: number; readonly progressMs: number } {
  return passes === media.segmentPasses
    ? { positionMs: media.segmentPositionMs, progressMs: 0 }
    : { positionMs: media.startAtMs, progressMs: progressTo(media, mediaEndMs(media), passes - 1) };
}

/** The points an arrival can start from in a pass: its origin, then the cue points after it before the range end. */
function passArrivalPoints(media: MediaTimeline, passes: number): number[] {
  const origin = passOrigin(media, passes).positionMs;
  const end = mediaEndMs(media);
  const cues = media.cues
    .map((cue) => mediaCuePointMs(media, cue))
    .filter((point) => point > origin && point < end && inRange(media, point));
  return [origin, ...new Set(cues)].sort((left, right) => left - right);
}

/** The progress committed when playback stands at arrival point `atMs` of the pass after `passes`. */
function standingProgressMs(media: MediaTimeline, passes: number, atMs: number): number {
  const origin = passOrigin(media, passes);
  return atMs === origin.positionMs
    ? origin.progressMs
    : Math.max(origin.progressMs, progressTo(media, atMs, passes));
}

/** The arrival the runtime commits next when it stands at arrival point `fromMs` of the pass after `passes`. */
function arrivalFrom(
  media: MediaTimeline,
  passes: number,
  fromMs: number,
): { progressMs: number; positionMs: number } {
  return nextArrival({
    ...media,
    positionMs: fromMs,
    committedProgressMs: standingProgressMs(media, passes, fromMs),
    passesCompleted: passes,
  });
}

/**
 * The arrival points of a pass an arrival at `positionMs` can have started from: the last one before it, and itself.
 * Playback continues from a cue arrival only while a repeat duration has not ended there.
 */
function predecessorsOf(media: MediaTimeline, passes: number, positionMs: number): number[] {
  const origin = passOrigin(media, passes).positionMs;
  const points = passArrivalPoints(media, passes).filter(
    (point) =>
      point === origin || standingProgressMs(media, passes, point) < budgetEndProgressMs(media),
  );
  const before = points.filter((point) => point < positionMs).at(-1);
  return [
    ...(before === undefined ? [] : [before]),
    ...(points.includes(positionMs) ? [positionMs] : []),
  ];
}

/**
 * Whether the runtime itself reaches this committed cursor of active media in its segment: it stands at its pass's
 * origin or on a cue arrival. Every arrival is recomputed with the runtime's own next-arrival step from its
 * predecessor, so restore validation accepts exactly what the timeline produces.
 */
export function reachableMediaCursor(media: PersistedMediaCursor): boolean {
  const passes = media.passesCompleted;
  if (passes < media.segmentPasses) return false;
  // Start cues wait at the origin of a pass, where playback has committed nothing beyond it.
  if (media.startCuesPending) {
    const origin = passOrigin(media, passes);
    if (
      media.positionMs !== origin.positionMs ||
      media.committedProgressMs !== origin.progressMs ||
      media.positionMs >= mediaEndMs(media) ||
      cuesAt(media, media.positionMs).length === 0
    )
      return false;
  }
  const end = mediaEndMs(media);
  const arrivesAt = (pass: number, positionMs: number, progressMs: number): boolean =>
    predecessorsOf(media, pass, positionMs).some((from) => {
      const arrival = arrivalFrom(media, pass, from);
      return arrival.positionMs === positionMs && arrival.progressMs === progressMs;
    });
  // A later pass of the segment starts only when the pass before ended with an arrival at the range end and the
  // repeat form continues, as when the runtime completes a pass.
  const started = (pass: number): boolean => {
    if (pass === media.segmentPasses) return true;
    const ended = progressTo(media, end, pass - 1);
    if (!arrivesAt(pass - 1, end, ended)) return false;
    switch (media.repeat.kind) {
      case "once":
        return false;
      case "indefinite":
        return true;
      case "count":
        return pass < media.repeat.passes;
      case "budget":
        return ended < budgetEndProgressMs(media);
    }
  };
  const position = media.positionMs;
  const committed = media.committedProgressMs;
  const origin = passOrigin(media, passes);
  if (position === origin.positionMs) return committed === origin.progressMs && started(passes);
  return position < end && started(passes) && arrivesAt(passes, position, committed);
}

/** Where a repeat duration ending at segment progress `endProgressMs` inside the pass after `passes` stands. */
function durationEndPositionMs(
  media: MediaTimeline,
  passes: number,
  endProgressMs: number,
): number {
  const from =
    passArrivalPoints(media, passes)
      .filter((point) => standingProgressMs(media, passes, point) < endProgressMs)
      .at(-1) ?? passOrigin(media, passes).positionMs;
  return arrivalFrom(media, passes, from).positionMs;
}

/**
 * Scene time at which reported playback reached `progressMs`, or `null` if not yet: the exact crossing rounded up to a
 * whole millisecond, so an observation at that time has always reported the crossing. Progress zero is reached at
 * the segment's anchor.
 */
function arrivalTime(
  points: readonly RuntimeMediaPointSnapshot[],
  progressMs: number,
): number | null {
  const index = points.findIndex((point) => point.progressMs >= progressMs);
  if (index < 0) return null;
  const after = points[index]!;
  if (index === 0 && after.progressMs === 0) return after.atMs;
  // A pruned first sample that already covers the progress lies in the crossing's whole millisecond: an earlier
  // millisecond would have made the arrival due before the samples before it were pruned.
  if (index === 0 || after.progressMs === progressMs) return Math.ceil(after.atMs);
  const before = points[index - 1]!;
  return interpolateCeilMs(
    before.progressMs,
    before.atMs,
    after.progressMs,
    after.atMs,
    progressMs,
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

/**
 * Reported segment progress at scene time `atMs`, interpolated exactly and rounded to whole milliseconds; never
 * extrapolated.
 */
function progressAt(points: readonly RuntimeMediaPointSnapshot[], atMs: number): number {
  let index = -1;
  for (let candidate = 0; candidate < points.length; candidate += 1) {
    if (points[candidate]!.atMs <= atMs) index = candidate;
  }
  if (index < 0) return Math.round(points[0]?.progressMs ?? 0);
  const before = points[index]!;
  const after = points[index + 1];
  if (after === undefined) return Math.round(before.progressMs);
  return interpolateRoundMs(before.atMs, before.progressMs, after.atMs, after.progressMs, atMs);
}

/**
 * The next event of loaded media, with its due time when reported progress covers it. Paused media still commits an
 * arrival it already stands on — the end of its range after a seek there, or a repeat duration used up exactly where
 * it was paused.
 */
export function nextMediaEvent(media: RuntimeMediaSnapshot): MediaTimelineEvent | null {
  if (!media.loaded || !isActiveMedia(media)) return null;
  if (media.state === "paused") {
    const reached = nextArrival(media);
    return reached.progressMs === media.committedProgressMs
      ? {
          kind: "arrival",
          progressMs: reached.progressMs,
          positionMs: reached.positionMs,
          dueAtMs: media.points[0]!.atMs,
        }
      : null;
  }
  if (departsNext(media)) {
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
  // An arrival where playback already stands fires only cues that have not fired there yet: pending start cues, or the
  // end of the range after a seek to it. A repeat duration that ends at its stretch's start does not repeat them.
  const fires =
    event.positionMs !== media.positionMs ||
    media.startCuesPending ||
    event.positionMs >= mediaEndMs(media);
  media.elapsedMs = elapsedAt(media, event.progressMs);
  media.committedProgressMs = event.progressMs;
  media.positionMs = event.positionMs;
  media.startCuesPending = false;
  const cueFunctionIds = fires ? cuesAt(media, media.positionMs) : [];
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
  if (media.committedProgressMs >= budgetEndProgressMs(media)) {
    media.state = "finished";
    return { cueFunctionIds, finished: true };
  }
  return { cueFunctionIds, finished: false };
}

/** Running media without cues in its active range, which produces nothing observable when a pass ends and repeats. */
export function repeatsSilently(media: RuntimeMediaSnapshot): boolean {
  return (
    media.state === "running" &&
    media.loaded &&
    !media.startCuesPending &&
    media.repeat.kind !== "once" &&
    !media.cues.some((cue) => inRange(media, mediaCuePointMs(media, cue)))
  );
}

/**
 * Catch-up moves silently repeating media directly to the last pass end due before the boundary, leaving that pass end
 * for an ordinary commit. A pass end due exactly at `limitMs` counts only when `includeLimit` says this media precedes
 * the work there. The result equals committing every pass end in turn: each pass end's progress comes from the same
 * anchor formula, `commitMediaEvent` commits the skipped ones' last, and the same repeat limits end both paths.
 */
export function skipSilentPasses(
  media: RuntimeMediaSnapshot,
  limitMs: number,
  includeLimit: boolean,
): void {
  if (!repeatsSilently(media)) return;
  const end = mediaEndMs(media);
  // Pass-end progress never decreases with the pass, so committing a later pass end leaves exactly its own progress.
  const passEndProgressMs = (passes: number): number =>
    Math.max(media.committedProgressMs, progressTo(media, end, passes));
  // Whether the pass after `passes` completed ones ends with playback repeating, reported by the boundary.
  const silentAndDue = (passes: number): boolean => {
    const progressMs = passEndProgressMs(passes);
    if (media.repeat.kind === "count" && passes + 1 >= media.repeat.passes) return false;
    if (progressMs >= budgetEndProgressMs(media)) return false;
    const dueAtMs = arrivalTime(media.points, progressMs);
    return dueAtMs !== null && (dueAtMs < limitMs || (includeLimit && dueAtMs === limitMs));
  };
  // Both conditions turn false at most once as passes grow, so a binary search finds the last silent due pass end in
  // bounded steps, also where many consecutive pass ends round to the same time.
  const first = media.passesCompleted;
  let last = first - 1;
  let high = Number.MAX_SAFE_INTEGER - 1;
  while (last < high) {
    const middle = last + Math.ceil((high - last) / 2);
    if (silentAndDue(middle)) last = middle;
    else high = middle - 1;
  }
  if (last <= first) return;
  media.passesCompleted = last - 1;
  commitMediaEvent(media, {
    kind: "arrival",
    progressMs: passEndProgressMs(last - 1),
    positionMs: end,
    dueAtMs: null,
  });
}

/**
 * Whether the next event is the departure of pending start cues; a repeat duration already used up ends before
 * playback departs again.
 */
function departsNext(media: RuntimeMediaSnapshot): boolean {
  return (
    media.startCuesPending &&
    media.positionMs < mediaEndMs(media) &&
    budgetEndProgressMs(media) > media.committedProgressMs
  );
}

/**
 * Segment progress at scene time `atMs`, never beyond the next uncommitted event: playback stands at pending start
 * cues until they depart, and an arrival due by then is reached exactly, so reads and segment changes agree with the
 * arrival's due time; other progress is in whole milliseconds.
 */
function progressBefore(media: RuntimeMediaSnapshot, atMs: number): number {
  if (media.state !== "running" || !media.loaded || departsNext(media))
    return media.committedProgressMs;
  const arrival = nextArrival(media);
  const dueAtMs = arrivalTime(media.points, arrival.progressMs);
  if (dueAtMs !== null && dueAtMs <= atMs) return arrival.progressMs;
  const reported = Math.max(media.committedProgressMs, progressAt(media.points, atMs));
  return Math.min(reported, arrival.progressMs);
}

/**
 * Starts a new segment at scene time `atMs` from the position playback reached by then. The caller has committed the
 * events due by then.
 */
/**
 * Where playback stands at segment progress `progressMs`, at most the next uncommitted arrival: exactly on that arrival
 * once reached, otherwise the committed position advanced by the progress since.
 */
function positionAtProgressMs(
  media: RuntimeMediaSnapshot,
  progressMs: number,
): { readonly positionMs: number; readonly reachedArrival: boolean } {
  if (progressMs > media.committedProgressMs) {
    const arrival = nextArrival(media);
    if (progressMs === arrival.progressMs)
      return { positionMs: arrival.positionMs, reachedArrival: true };
  }
  return {
    positionMs: media.positionMs + (progressMs - media.committedProgressMs),
    reachedArrival: false,
  };
}

function startSegment(media: RuntimeMediaSnapshot, atMs: number): void {
  const progress = progressBefore(media, atMs);
  if (progress > media.committedProgressMs) {
    const reached = positionAtProgressMs(media, progress);
    media.positionMs = reached.positionMs;
    // Playback that reached an arrival whose turn has not come yet at this scene time stands exactly on it; cues
    // there stay pending.
    if (reached.reachedArrival && media.positionMs < mediaEndMs(media)) {
      media.startCuesPending = cuesAt(media, media.positionMs).length > 0;
    }
    media.elapsedMs = elapsedAt(media, progress);
  }
  anchorSegment(media, atMs);
}

/** Begins a new segment at scene time `atMs` from the current position, passes, and total playback. */
function anchorSegment(media: RuntimeMediaSnapshot, atMs: number): void {
  media.segment += 1;
  media.committedProgressMs = 0;
  media.segmentPositionMs = media.positionMs;
  media.segmentPasses = media.passesCompleted;
  media.segmentElapsedMs = media.elapsedMs;
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
    return `Media "${media.source}" has no playback range: startAt is not before the end of the source, which lasts ${formatDuration(durationMs)}.`;
  }
  media.positionMs = media.startAtMs;
  media.startCuesPending = cuesAt(media, media.startAtMs).length > 0;
  anchorSegment(media, atMs);
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

/**
 * Scripts get handles only to loaded or settled media: a play binds its handle after the load report, and host values
 * cannot carry handles. Pause, resume, and seeks therefore always have a timeline; unloaded media can only stop, through
 * a null source, a load failure, Stage replacement, or the end of the session. Restore validation does not check this
 * for state the runtime does not produce, such as a hand-edited checkpoint that binds the handle of loading media.
 */
export function pauseMedia(media: MediaHandleRecord, atMs: number): MediaWarning | null {
  if (media.state === "paused") return null;
  if (media.state !== "running") return settledWarning(media, "pause()");
  startSegment(media, atMs);
  media.state = "paused";
  return null;
}

export function resumeMedia(media: MediaHandleRecord, atMs: number): MediaWarning | null {
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
 * Seeks to the source position `milliseconds`, or to `milliseconds` before the effective end, clamped to the active
 * range. Cues strictly between the old and new position do not fire; cues at the new position fire once playback
 * proceeds from it, and a seek to the end completes the pass at once.
 */
export function seekMedia(
  media: MediaHandleRecord,
  milliseconds: number,
  atMs: number,
  operation: "position" | "remaining",
): MediaWarning | null {
  if (media.state !== "running" && media.state !== "paused")
    return settledWarning(media, operation);
  startSegment(media, atMs);
  const end = mediaEndMs(media);
  const requestedMs = operation === "position" ? milliseconds : end - milliseconds;
  media.positionMs = Math.min(Math.max(requestedMs, media.startAtMs), end);
  media.segmentPositionMs = media.positionMs;
  media.startCuesPending = media.positionMs < end && cuesAt(media, media.positionMs).length > 0;
  return null;
}

export function setMediaVolume(media: MediaHandleRecord, volume: number): MediaWarning | null {
  if (media.state !== "running" && media.state !== "paused") return settledWarning(media, "volume");
  media.volume = volume;
  return null;
}

/** The properties a media handle has, which {@link mediaProperty} reads and restore validation accepts. */
export const MEDIA_PROPERTIES: ReadonlySet<string> = new Set([
  "position",
  "elapsed",
  "remaining",
  "duration",
  "volume",
  "state",
]);

/**
 * Handle property reads at scene time `atMs`; `undefined` means the property does not exist. Finished and stopped
 * media read where playback ended, and no `remaining` time once the source loaded.
 */
export function mediaProperty(
  media: MediaHandleRecord,
  name: string,
  atMs: number,
): SerializableRuntimeValue | undefined {
  if (!MEDIA_PROPERTIES.has(name)) return undefined;
  const duration = (milliseconds: number): SerializableRuntimeValue => ({
    kind: "duration",
    milliseconds,
  });
  const active = media.state === "running" || media.state === "paused" ? media : null;
  const advanced = (): number =>
    active === null ? 0 : progressBefore(active, atMs) - active.committedProgressMs;
  const position = (): number =>
    active === null
      ? media.positionMs
      : positionAtProgressMs(active, progressBefore(active, atMs)).positionMs;
  switch (name) {
    case "position":
      return duration(position());
    case "elapsed":
      return duration(media.elapsedMs + advanced());
    case "remaining":
      if (media.durationMs === null) return null;
      return duration(active === null ? 0 : Math.max(0, mediaEndMs(active) - position()));
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
  switch (media.repeat.kind) {
    case "once":
      return progressTo(media, end, media.passesCompleted);
    case "count":
      return progressTo(media, end, media.repeat.passes - 1);
    case "budget":
      return Math.max(media.committedProgressMs, budgetEndProgressMs(media));
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
  const progress = terminal === null ? reported : Math.min(reported, terminal);
  const end = mediaEndMs(media);
  const passes = media.passesCompleted;
  // Pass ends come from the anchor formula, so they agree exactly with the arrivals the timeline commits.
  const passEnd = (pass: number): number => progressTo(media, end, pass);
  const durationEnded = progress === terminal && media.repeat.kind === "budget";
  // Progress that reaches an arrival point of its pass stands exactly where the timeline commits that arrival.
  const withinPass = (pass: number): number => {
    const from = pass === passes ? media.positionMs : media.startAtMs;
    if (pass === passes && progress === media.committedProgressMs) return from;
    const arrival = passArrivalPoints(media, pass).find(
      (point) => point > from && standingProgressMs(media, pass, point) === progress,
    );
    if (arrival !== undefined) return arrival;
    return pass === passes
      ? Math.min(end, media.positionMs + (progress - media.committedProgressMs))
      : Math.min(end, media.startAtMs + (progress - passEnd(pass - 1)));
  };
  if (progress < passEnd(passes)) {
    // A repeat duration ends where the timeline will commit its end.
    if (durationEnded) return durationEndPositionMs(media, passes, progress);
    return withinPass(passes);
  }
  const passLength = end - media.startAtMs;
  if (passLength <= 0) return end;
  // The pass `passes + laps` contains the progress: the first whose end reaches it, found by bisection over exactly
  // countable pass ordinals. Beyond them only the position within a pass is meaningful.
  const beyond = progress - passEnd(passes);
  let high = Math.ceil(beyond / passLength) + 1;
  if (!Number.isSafeInteger(passes + high) || passEnd(passes + high) < progress) {
    const within = beyond % passLength;
    // Counted playback ends at the end of its last pass, and so does a repeat duration that ends at a pass boundary.
    if (progress === terminal && (media.repeat.kind !== "budget" || within === 0)) return end;
    return Math.min(end, media.startAtMs + within);
  }
  let laps = 0;
  while (laps < high) {
    const middle = laps + Math.floor((high - laps) / 2);
    if (passEnd(passes + middle) >= progress) high = middle;
    else laps = middle + 1;
  }
  if (progress === passEnd(passes + laps)) {
    // Playback that ends exactly at the end of a pass stays at that end; otherwise it wraps to the next pass.
    return progress === terminal ? end : media.startAtMs;
  }
  if (durationEnded) return durationEndPositionMs(media, passes + laps, progress);
  return withinPass(passes + laps);
}

function settledWarning(media: MediaHandleRecord, operation: string): MediaWarning {
  return {
    code: "TSW010",
    message: `Media ${operation} has no effect because the media is already ${media.state}.`,
  };
}

export function cloneMedia(media: RuntimeMediaSnapshot): RuntimeMediaSnapshot {
  return {
    ...media,
    captures: cloneCaptures(media.captures),
    repeat: { ...media.repeat },
    cues: media.cues.map((cue) => ({ ...cue })),
    points: media.points.map((point) => ({ ...point })),
  };
}
