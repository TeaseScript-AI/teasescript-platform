import type { InstructionPlan } from "../plan/model.js";
import { isValidSessionTime } from "./actions/delay.js";
import {
  reachableMediaCursor,
  type RuntimeMediaCueSnapshot,
  type RuntimeMediaRepeatSnapshot,
} from "./media.js";

/** Restore validation for media playback records, their handles, queued cue blocks, and cue-block frames. */

const MEDIA_KEYS = [
  "mediaId",
  "media",
  "source",
  "state",
  "loaded",
  "durationMs",
  "startAtMs",
  "endAtMs",
  "volume",
  "repeat",
  "cues",
  "finishFunctionId",
  "segment",
  "committedProgressMs",
  "positionMs",
  "elapsedMs",
  "passesCompleted",
  "segmentPositionMs",
  "segmentPasses",
  "segmentElapsedMs",
  "startCuesPending",
  "points",
] as const;

const MEDIA_ACTION_KEYS = [
  "kind",
  "actionId",
  "owningInstruction",
  "createdAtMs",
  "requestEventSequence",
  "media",
] as const;

export function validMediaAction(
  action: Record<string, unknown>,
  snapshot: Record<string, unknown>,
  plan: InstructionPlan | undefined,
): boolean {
  const now = snapshot.currentSessionTimeMs;
  if (
    !hasExactKeys(action, MEDIA_ACTION_KEYS) ||
    action.kind !== "media" ||
    !positiveSafeInteger(action.actionId) ||
    !positiveSafeInteger(snapshot.nextActionId) ||
    action.actionId >= snapshot.nextActionId ||
    !positiveSafeInteger(action.requestEventSequence) ||
    !positiveSafeInteger(snapshot.nextEventSequence) ||
    action.requestEventSequence >= snapshot.nextEventSequence ||
    !isValidSessionTime(action.createdAtMs) ||
    !isValidSessionTime(now) ||
    action.createdAtMs > now ||
    !nonNegativeSafeInteger(action.owningInstruction) ||
    !isPlainRecord(action.media) ||
    !validMediaRecord(action.media, true, snapshot, plan)
  ) {
    return false;
  }
  if (plan === undefined) return true;
  const owner = plan.instructions[action.owningInstruction];
  const media = action.media;
  return (
    owner?.kind === "playMedia" &&
    owner.media === media.media &&
    owner.finishFunctionId === media.finishFunctionId &&
    Array.isArray(media.cues) &&
    owner.cues.length === media.cues.length &&
    owner.cues.every((cue, index) => {
      const recorded: unknown = Array.isArray(media.cues) ? media.cues[index] : undefined;
      return (
        isPlainRecord(recorded) &&
        recorded.kind === cue.kind &&
        recorded.functionId === cue.functionId
      );
    })
  );
}

function validMediaRecord(
  media: Record<string, unknown>,
  active: boolean,
  snapshot: Record<string, unknown>,
  plan: InstructionPlan | undefined,
): boolean {
  if (
    !hasExactKeys(media, MEDIA_KEYS) ||
    !positiveSafeInteger(media.mediaId) ||
    (media.media !== "audio" && media.media !== "video") ||
    typeof media.source !== "string" ||
    typeof media.loaded !== "boolean" ||
    !validMilliseconds(media.startAtMs) ||
    (media.endAtMs !== null &&
      (!validMilliseconds(media.endAtMs) || media.endAtMs <= media.startAtMs)) ||
    typeof media.volume !== "number" ||
    !(media.volume >= 0 && media.volume <= 1) ||
    !validRepeat(media.repeat) ||
    !validCues(media.cues, plan) ||
    !validHandlerId(media.finishFunctionId, plan, true) ||
    !nonNegativeSafeInteger(media.segment) ||
    !validMilliseconds(media.committedProgressMs) ||
    !validMilliseconds(media.positionMs) ||
    !validMilliseconds(media.elapsedMs) ||
    !nonNegativeSafeInteger(media.passesCompleted) ||
    !validMilliseconds(media.segmentPositionMs) ||
    !nonNegativeSafeInteger(media.segmentPasses) ||
    !validMilliseconds(media.segmentElapsedMs) ||
    typeof media.startCuesPending !== "boolean" ||
    !validPoints(media.points, snapshot.observedSessionTimeMs)
  ) {
    return false;
  }
  const points = media.points;
  if (!isPointList(points)) return false;
  const unanchored =
    media.segmentPositionMs === media.startAtMs &&
    media.segmentPasses === 0 &&
    media.segmentElapsedMs === 0;
  if (!media.loaded) {
    // Only an unloaded source can report no duration; it never started a segment.
    return (
      media.durationMs === null &&
      media.segment === 0 &&
      points.length === 0 &&
      media.committedProgressMs === 0 &&
      media.elapsedMs === 0 &&
      media.passesCompleted === 0 &&
      !media.startCuesPending &&
      media.positionMs === media.startAtMs &&
      unanchored &&
      (active ? media.state === "running" : media.state === "stopped")
    );
  }
  if (!validMilliseconds(media.durationMs)) return false;
  const end = media.endAtMs === null ? media.durationMs : Math.min(media.endAtMs, media.durationMs);
  if (media.startAtMs >= end) {
    // A load with an empty range stops before any playback; playback itself needs a positive range length.
    return (
      !active &&
      media.state === "stopped" &&
      media.segment === 0 &&
      points.length === 0 &&
      media.positionMs === media.startAtMs &&
      media.committedProgressMs === 0 &&
      media.elapsedMs === 0 &&
      unanchored
    );
  }
  if (
    media.positionMs < media.startAtMs ||
    media.positionMs > end ||
    media.segmentPositionMs < media.startAtMs ||
    media.segmentPositionMs > end ||
    media.segmentPasses > media.passesCompleted ||
    media.elapsedMs !==
      elapsedAtCommitted(media, media.segmentElapsedMs, media.committedProgressMs) ||
    !reachableMediaCursor(
      {
        durationMs: media.durationMs,
        startAtMs: media.startAtMs,
        endAtMs: media.endAtMs,
        repeat: media.repeat,
        cues: media.cues,
        segmentPositionMs: media.segmentPositionMs,
        segmentPasses: media.segmentPasses,
        segmentElapsedMs: media.segmentElapsedMs,
        positionMs: media.positionMs,
        committedProgressMs: media.committedProgressMs,
        passesCompleted: media.passesCompleted,
        startCuesPending: media.startCuesPending,
      },
      media.state === "finished",
    )
  )
    return false;
  // A stop starts a final segment at the stop position.
  const atAnchor =
    media.segmentPositionMs === media.positionMs &&
    media.segmentPasses === media.passesCompleted &&
    media.segmentElapsedMs === media.elapsedMs;
  // Segments start at current scene time, so no retained sample lies after it.
  const head = points[0];
  if (
    head !== undefined &&
    typeof snapshot.currentSessionTimeMs === "number" &&
    head.atMs > snapshot.currentSessionTimeMs
  )
    return false;
  const reportedProgress = points.at(-1)?.progressMs ?? 0;
  const segmentStart = points.length === 1 && points[0]!.progressMs === 0;
  switch (media.state) {
    case "running":
      return (
        active &&
        media.segment >= 1 &&
        points.length > 0 &&
        media.committedProgressMs <= reportedProgress &&
        withinRepeatLimit(media)
      );
    case "paused":
      return (
        active &&
        media.segment >= 1 &&
        segmentStart &&
        media.committedProgressMs === 0 &&
        withinRepeatLimit(media)
      );
    case "finished":
      return (
        !active &&
        media.segment >= 1 &&
        media.committedProgressMs <= reportedProgress &&
        reachedRepeatLimit(media)
      );
    case "stopped":
      return (
        !active && media.segment >= 1 && segmentStart && atAnchor && media.committedProgressMs === 0
      );
    default:
      return false;
  }
}

/**
 * Total playback at the committed segment progress, calculated as the runtime does: a used-up repeat duration is
 * exactly its length.
 */
function elapsedAtCommitted(
  media: Record<string, unknown>,
  segmentElapsedMs: number,
  committedProgressMs: number,
): number {
  const repeat = media.repeat;
  if (!isPlainRecord(repeat) || repeat.kind !== "budget" || typeof repeat.milliseconds !== "number")
    return segmentElapsedMs + committedProgressMs;
  return committedProgressMs >= repeat.milliseconds - segmentElapsedMs
    ? repeat.milliseconds
    : Math.min(repeat.milliseconds, segmentElapsedMs + committedProgressMs);
}

/** Finished media ended naturally: after its only or last counted pass, or when its duration budget ran out. */
function reachedRepeatLimit(media: Record<string, unknown>): boolean {
  const repeat = media.repeat;
  if (!isPlainRecord(repeat) || typeof media.passesCompleted !== "number") return false;
  switch (repeat.kind) {
    case "once":
      return media.passesCompleted === 1;
    case "count":
      return media.passesCompleted === repeat.passes;
    case "budget":
      return (
        typeof media.elapsedMs === "number" &&
        typeof repeat.milliseconds === "number" &&
        media.elapsedMs >= repeat.milliseconds
      );
    default:
      return false;
  }
}

/**
 * An active media record has not used up a count limit. A duration budget may be used up exactly, while the arrival
 * that finishes the media waits to be committed.
 */
function withinRepeatLimit(media: Record<string, unknown>): boolean {
  const repeat = media.repeat;
  if (!isPlainRecord(repeat)) return false;
  if (repeat.kind === "count") {
    return (
      typeof media.passesCompleted === "number" &&
      typeof repeat.passes === "number" &&
      media.passesCompleted < repeat.passes
    );
  }
  if (repeat.kind === "budget") {
    return (
      typeof media.elapsedMs === "number" &&
      typeof repeat.milliseconds === "number" &&
      media.elapsedMs <= repeat.milliseconds
    );
  }
  if (repeat.kind === "once") return media.passesCompleted === 0;
  return true;
}

function isPointList(value: unknown): value is readonly { atMs: number; progressMs: number }[] {
  return (
    Array.isArray(value) &&
    value.every(
      (point) =>
        isPlainRecord(point) &&
        typeof point.atMs === "number" &&
        typeof point.progressMs === "number",
    )
  );
}

function validRepeat(value: unknown): value is RuntimeMediaRepeatSnapshot {
  if (!isPlainRecord(value)) return false;
  switch (value.kind) {
    case "once":
    case "indefinite":
      return hasExactKeys(value, ["kind"]);
    case "count":
      return hasExactKeys(value, ["kind", "passes"]) && positiveSafeInteger(value.passes);
    case "budget":
      return (
        hasExactKeys(value, ["kind", "milliseconds"]) &&
        validMilliseconds(value.milliseconds) &&
        value.milliseconds > 0
      );
    default:
      return false;
  }
}

function validCues(
  value: unknown,
  plan: InstructionPlan | undefined,
): value is RuntimeMediaCueSnapshot[] {
  return (
    isCanonicalJsonArray(value) &&
    value.every(
      (cue) =>
        isPlainRecord(cue) &&
        hasExactKeys(cue, ["kind", "offsetMs", "functionId"]) &&
        (cue.kind === "at" || cue.kind === "beforeEnd") &&
        validMilliseconds(cue.offsetMs) &&
        validHandlerId(cue.functionId, plan, false),
    )
  );
}

function validHandlerId(
  value: unknown,
  plan: InstructionPlan | undefined,
  nullable: boolean,
): boolean {
  if (value === null) return nullable;
  if (!positiveSafeInteger(value)) return false;
  return plan === undefined || plan.functions[value - 1]?.handler === "media";
}

/** Samples increase strictly in scene time, never decrease in progress, and were observed no later than now. */
function validPoints(value: unknown, observedSessionTimeMs: unknown): boolean {
  if (!isCanonicalJsonArray(value) || !isValidSessionTime(observedSessionTimeMs)) return false;
  let previous: { atMs: number; progressMs: number } | null = null;
  for (const point of value) {
    if (
      !isPlainRecord(point) ||
      !hasExactKeys(point, ["atMs", "progressMs"]) ||
      !isValidSessionTime(point.atMs) ||
      !validMilliseconds(point.progressMs) ||
      point.atMs > observedSessionTimeMs ||
      (previous !== null && (point.atMs <= previous.atMs || point.progressMs < previous.progressMs))
    ) {
      return false;
    }
    previous = { atMs: point.atMs, progressMs: point.progressMs };
  }
  return true;
}

/**
 * Every issued media ID has exactly one active or settled record, handles refer only to issued IDs, and queued cue
 * blocks and cue-block frames belong to their media's own blocks. Only one video is active.
 */
export function validateMediaState(
  value: Record<string, unknown>,
  plan: InstructionPlan | undefined,
  handleIds: ReadonlySet<number>,
  errors: string[],
): void {
  const nextMediaId = value.nextMediaId;
  if (!positiveSafeInteger(nextMediaId)) {
    errors.push("Runtime nextMediaId must be a positive safe integer.");
    return;
  }
  const records = new Map<number, Record<string, unknown>>();
  const add = (media: Record<string, unknown>): void => {
    if (!positiveSafeInteger(media.mediaId)) return;
    if (records.has(media.mediaId)) errors.push("Runtime media IDs must be unique.");
    records.set(media.mediaId, media);
  };
  const settled = value.settledMedia;
  if (!isCanonicalJsonArray(settled)) {
    errors.push("Runtime settledMedia must be an array.");
  } else {
    for (const media of settled) {
      if (!isPlainRecord(media) || !validMediaRecord(media, false, value, plan)) {
        errors.push("Runtime settled media is malformed.");
        continue;
      }
      add(media);
    }
  }
  let activeVideos = 0;
  if (Array.isArray(value.backgroundActions)) {
    for (const action of value.backgroundActions) {
      if (isPlainRecord(action) && action.kind === "media" && isPlainRecord(action.media)) {
        add(action.media);
        if (action.media.media === "video") activeVideos += 1;
      }
    }
  }
  if (activeVideos > 1) errors.push("Runtime has more than one active Stage video.");
  if (records.size !== nextMediaId - 1 || [...records.keys()].some((id) => id >= nextMediaId)) {
    errors.push("Runtime media do not match the issued media IDs.");
  }
  for (const id of handleIds) {
    if (!records.has(id)) errors.push("Runtime media handle refers to unissued media.");
  }
  const ownsHandler = (media: Record<string, unknown> | undefined, functionId: unknown): boolean =>
    media !== undefined &&
    (media.finishFunctionId === functionId ||
      (Array.isArray(media.cues) &&
        media.cues.some((cue) => isPlainRecord(cue) && cue.functionId === functionId)));
  // Cue blocks exist only for loaded media; `finish` runs once, after the media finished.
  const finishRuns = new Map<number, number>();
  const validOwner = (
    media: Record<string, unknown> | undefined,
    functionId: unknown,
    count: number,
  ) => {
    if (media === undefined || !ownsHandler(media, functionId) || media.loaded !== true)
      return false;
    if (functionId !== media.finishFunctionId) return true;
    if (!positiveSafeInteger(media.mediaId)) return false;
    finishRuns.set(media.mediaId, (finishRuns.get(media.mediaId) ?? 0) + count);
    return media.state === "finished";
  };
  if (Array.isArray(value.pendingTimerHandlers)) {
    for (const invocation of value.pendingTimerHandlers) {
      if (!isPlainRecord(invocation) || !Object.hasOwn(invocation, "mediaId")) continue;
      const media = positiveSafeInteger(invocation.mediaId)
        ? records.get(invocation.mediaId)
        : undefined;
      if (
        !hasExactKeys(invocation, ["mediaId", "handlerFunctionId", "dueAtMs", "count"]) ||
        !positiveSafeInteger(invocation.count) ||
        media?.state === "stopped" ||
        !validOwner(media, invocation.handlerFunctionId, invocation.count)
      ) {
        errors.push("Runtime pending media cue block is malformed.");
      }
    }
  }
  if (Array.isArray(value.callFrames)) {
    for (const frame of value.callFrames) {
      if (
        !isPlainRecord(frame) ||
        !isPlainRecord(frame.timerInterruption) ||
        !Object.hasOwn(frame.timerInterruption, "mediaId")
      )
        continue;
      const media = positiveSafeInteger(frame.timerInterruption.mediaId)
        ? records.get(frame.timerInterruption.mediaId)
        : undefined;
      if (!validOwner(media, frame.functionId, 1)) {
        errors.push("Runtime media cue-block frame does not belong to its media.");
      }
    }
  }
  if ([...finishRuns.values()].some((count) => count > 1)) {
    errors.push("Runtime media finish block runs more than once.");
  }
  if (
    (value.status === "halted" || value.status === "ready") &&
    Array.isArray(value.backgroundActions) &&
    value.backgroundActions.some((action) => isPlainRecord(action) && action.kind === "media")
  ) {
    errors.push("Runtime active media require an active session.");
  }
}

function validMilliseconds(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function isCanonicalJsonArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && Object.keys(value).length === value.length;
}
