import type { InstructionPlan, PlayMediaInstruction } from "../plan/model.js";
import { sameCaptures } from "./capture-validation.js";
import { rootFitsFunction, serializedRootFiles } from "./activation-validation.js";
import { isValidSessionTime } from "./actions/delay.js";
import {
  reachableMediaCursor,
  type RuntimeMediaCueSnapshot,
  type RuntimeMediaRepeatSnapshot,
} from "./media.js";

/** Restore validation for media playback records, their handles, queued cue blocks, and cue-block frames. */

const SETTLED_MEDIA_KEYS = [
  "mediaId",
  "source",
  "state",
  "durationMs",
  "volume",
  "positionMs",
  "elapsedMs",
] as const;

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
  "handlerRootScopeId",
  "captures",
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
    !validMediaRecord(action.media, snapshot, plan)
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

/** A settled record keeps what a handle reads; a source that never loaded stopped without playing. */
function validSettledMediaRecord(media: Record<string, unknown>): boolean {
  return (
    hasExactKeys(media, SETTLED_MEDIA_KEYS) &&
    positiveSafeInteger(media.mediaId) &&
    typeof media.source === "string" &&
    (media.state === "finished" || media.state === "stopped") &&
    typeof media.volume === "number" &&
    media.volume >= 0 &&
    media.volume <= 1 &&
    validMilliseconds(media.positionMs) &&
    validMilliseconds(media.elapsedMs) &&
    (media.durationMs === null
      ? media.state === "stopped" && media.elapsedMs === 0
      : validMilliseconds(media.durationMs))
  );
}

/** An active media record: running or paused, with its timeline, blocks, and the samples of its current segment. */
function validMediaRecord(
  media: Record<string, unknown>,
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
    // Cue and finish blocks see the top-level names of the activation that started the media.
    (media.handlerRootScopeId === null) !==
      (media.finishFunctionId === null && Array.isArray(media.cues) && media.cues.length === 0) ||
    (media.handlerRootScopeId !== null && !nonNegativeSafeInteger(media.handlerRootScopeId)) ||
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
      media.state === "running"
    );
  }
  if (!validMilliseconds(media.durationMs)) return false;
  const end = media.endAtMs === null ? media.durationMs : Math.min(media.endAtMs, media.durationMs);
  // A load with an empty range stops before any playback; playback itself needs a positive range length.
  if (media.startAtMs >= end) return false;
  if (
    media.positionMs < media.startAtMs ||
    media.positionMs > end ||
    media.segmentPositionMs < media.startAtMs ||
    media.segmentPositionMs > end ||
    media.segmentPasses > media.passesCompleted ||
    media.elapsedMs !==
      elapsedAtCommitted(media, media.segmentElapsedMs, media.committedProgressMs) ||
    !reachableMediaCursor({
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
    })
  )
    return false;
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
        media.segment >= 1 &&
        points.length > 0 &&
        media.committedProgressMs <= reportedProgress &&
        withinRepeatLimit(media)
      );
    case "paused":
      return (
        media.segment >= 1 &&
        segmentStart &&
        media.committedProgressMs === 0 &&
        withinRepeatLimit(media)
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
 * Each issued media ID has at most one active or settled record, every handle and every queued or running cue block has
 * the record of its media, and cue blocks and cue-block frames belong to their media's own blocks: those an active
 * record lists, or for settled media, whose record no longer lists them, blocks of one play that share one activation
 * root and its variables. Only one video is active.
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
  const settledRecords = new Set<Record<string, unknown>>();
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
      if (!isPlainRecord(media) || !validSettledMediaRecord(media)) {
        errors.push("Runtime settled media is malformed.");
        continue;
      }
      settledRecords.add(media);
      add(media);
    }
  }
  let activeVideos = 0;
  const roots = serializedRootFiles(value);
  if (Array.isArray(value.backgroundActions)) {
    for (const action of value.backgroundActions) {
      if (isPlainRecord(action) && action.kind === "media" && isPlainRecord(action.media)) {
        add(action.media);
        const handler =
          action.media.finishFunctionId ??
          (Array.isArray(action.media.cues) && isPlainRecord(action.media.cues[0])
            ? action.media.cues[0].functionId
            : null);
        if (
          handler !== null &&
          !rootFitsFunction(plan, roots, action.media.handlerRootScopeId, handler)
        ) {
          errors.push("Runtime media refer to an impossible activation.");
        }
        if (action.media.media === "video") activeVideos += 1;
      }
    }
  }
  if (activeVideos > 1) errors.push("Runtime has more than one active Stage video.");
  // Settled media that nothing reaches anymore are dropped, so issued IDs may have no record.
  if ([...records.keys()].some((id) => id >= nextMediaId)) {
    errors.push("Runtime media IDs must be issued IDs below nextMediaId.");
  }
  for (const id of handleIds) {
    if (!records.has(id)) errors.push("Runtime media handle refers to media without a record.");
  }
  const ownsHandler = (media: Record<string, unknown>, functionId: unknown): boolean =>
    media.finishFunctionId === functionId ||
    (Array.isArray(media.cues) &&
      media.cues.some((cue) => isPlainRecord(cue) && cue.functionId === functionId));
  // Blocks of active media must be listed by their record; `finish` runs only once the media finished, when it settled.
  // The blocks of settled media, whose record no longer lists them, are collected and checked together below.
  const settledBlocks = new Map<
    Record<string, unknown>,
    { functionId: unknown; count: number; rootScopeId: unknown; captures: unknown }[]
  >();
  const validOwner = (
    media: Record<string, unknown> | undefined,
    functionId: unknown,
    count: number,
    rootScopeId: unknown,
    captures: unknown,
  ) => {
    if (media === undefined) return false;
    if (settledRecords.has(media)) {
      // Cue blocks exist only for loaded media.
      if (media.durationMs === null) return false;
      const blocks = settledBlocks.get(media) ?? [];
      blocks.push({ functionId, count, rootScopeId, captures });
      settledBlocks.set(media, blocks);
      return true;
    }
    return (
      ownsHandler(media, functionId) &&
      functionId !== media.finishFunctionId &&
      media.loaded === true &&
      rootScopeId === media.handlerRootScopeId &&
      sameCaptures(captures, media.captures)
    );
  };
  const invocations = new Map<unknown, Map<unknown, number>>();
  const countInvocation = (mediaId: unknown, functionId: unknown, count: unknown): void => {
    if (!positiveSafeInteger(count)) return;
    const byFunction = invocations.get(mediaId) ?? new Map<unknown, number>();
    byFunction.set(functionId, (byFunction.get(functionId) ?? 0) + count);
    invocations.set(mediaId, byFunction);
  };
  if (Array.isArray(value.pendingTimerHandlers)) {
    for (const invocation of value.pendingTimerHandlers) {
      if (!isPlainRecord(invocation) || !Object.hasOwn(invocation, "mediaId")) continue;
      countInvocation(invocation.mediaId, invocation.handlerFunctionId, invocation.count);
      const media = positiveSafeInteger(invocation.mediaId)
        ? records.get(invocation.mediaId)
        : undefined;
      if (
        !hasExactKeys(invocation, [
          "mediaId",
          "handlerFunctionId",
          "rootScopeId",
          "captures",
          "dueAtMs",
          "count",
        ]) ||
        !positiveSafeInteger(invocation.count) ||
        !rootFitsFunction(plan, roots, invocation.rootScopeId, invocation.handlerFunctionId) ||
        media?.state === "stopped" ||
        !validOwner(
          media,
          invocation.handlerFunctionId,
          invocation.count,
          invocation.rootScopeId,
          invocation.captures,
        )
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
      countInvocation(frame.timerInterruption.mediaId, frame.functionId, 1);
      const media = positiveSafeInteger(frame.timerInterruption.mediaId)
        ? records.get(frame.timerInterruption.mediaId)
        : undefined;
      if (!validOwner(media, frame.functionId, 1, frame.rootScopeId, frame.captures)) {
        errors.push("Runtime media cue-block frame does not belong to its media.");
      }
    }
  }
  // The blocks of one settled media share one activation root and its variables and are blocks of one play, under which
  // `finish` runs at most once and only after the media finished. Plays may share block functions, so the candidates are
  // the plays that use every one of them.
  let blockPlays: Map<unknown, Set<PlayMediaInstruction>> | undefined;
  const playsUsing = (functionId: unknown): ReadonlySet<PlayMediaInstruction> => {
    if (blockPlays === undefined) {
      blockPlays = new Map();
      for (const instruction of plan?.instructions ?? []) {
        if (instruction?.kind !== "playMedia") continue;
        const uses = [...instruction.cues.map((cue) => cue.functionId)];
        if (instruction.finishFunctionId !== null) uses.push(instruction.finishFunctionId);
        for (const used of uses) {
          const plays = blockPlays.get(used) ?? new Set<PlayMediaInstruction>();
          plays.add(instruction);
          blockPlays.set(used, plays);
        }
      }
    }
    return blockPlays.get(functionId) ?? new Set();
  };
  for (const [media, blocks] of settledBlocks) {
    const first = blocks[0]!;
    const runs = new Map<unknown, number>();
    for (const block of blocks)
      runs.set(block.functionId, (runs.get(block.functionId) ?? 0) + block.count);
    let candidates = [...playsUsing(first.functionId)];
    for (const functionId of runs.keys()) {
      const plays = playsUsing(functionId);
      candidates = candidates.filter((play) => plays.has(play));
    }
    const finishFits = (play: PlayMediaInstruction): boolean => {
      const finishRuns = runs.get(play.finishFunctionId) ?? 0;
      return finishRuns === 0 || (finishRuns === 1 && media.state === "finished");
    };
    if (
      blocks.some(
        (block) =>
          block.rootScopeId !== first.rootScopeId || !sameCaptures(block.captures, first.captures),
      ) ||
      (plan !== undefined && !candidates.some(finishFits))
    ) {
      errors.push("Runtime settled media blocks do not belong to one play.");
    }
  }
  for (const [mediaId, media] of records) {
    if (
      !settledRecords.has(media) &&
      !cueBookkeepingFits(media, invocations.get(mediaId) ?? new Map<unknown, number>())
    ) {
      errors.push("Runtime media cue bookkeeping does not match its playback.");
    }
  }
  if (
    (value.status === "halted" || value.status === "ready") &&
    Array.isArray(value.backgroundActions) &&
    value.backgroundActions.some((action) => isPlainRecord(action) && action.kind === "media")
  ) {
    errors.push("Runtime active media require an active session.");
  }
}

/**
 * Active media that have played only since loading (segment 1, no control since) fix their cue bookkeeping: a start cue at
 * a pass origin is pending until reported playback moves past it, when its departure queues it; in the first pass a
 * pending start cue has not been queued yet; and a cue's queued and running invocations cannot outnumber the passes
 * that reached its point. Later segments may follow seeks and pauses whose history is not retained.
 */
function cueBookkeepingFits(
  media: Record<string, unknown>,
  invocations: ReadonlyMap<unknown, number>,
): boolean {
  const { segment, loaded, points, cues, durationMs, endAtMs, startAtMs, positionMs } = media;
  const { passesCompleted, committedProgressMs, startCuesPending } = media;
  if (
    segment !== 1 ||
    loaded !== true ||
    !isPointList(points) ||
    !Array.isArray(cues) ||
    !validMilliseconds(durationMs) ||
    !validMilliseconds(startAtMs) ||
    !validMilliseconds(positionMs) ||
    !validMilliseconds(committedProgressMs) ||
    !nonNegativeSafeInteger(passesCompleted)
  )
    return true;
  const end = typeof endAtMs === "number" ? Math.min(endAtMs, durationMs) : durationMs;
  const cuePoints = cues.flatMap((cue: unknown) => {
    if (!isPlainRecord(cue) || typeof cue.offsetMs !== "number") return [];
    const point = cue.kind === "at" ? cue.offsetMs : end - cue.offsetMs;
    return point >= startAtMs && point <= end ? [{ point, functionId: cue.functionId }] : [];
  });
  // The load anchors segment 1 at the range start; a later pass starts there too.
  const origin = startAtMs;
  const atOrigin = positionMs === origin && positionMs < end;
  const originCues = cuePoints.filter((cue) => cue.point === origin);
  if (atOrigin && originCues.length > 0) {
    const reported = points.at(-1)?.progressMs ?? 0;
    if (startCuesPending !== true && reported <= committedProgressMs) return false;
    if (
      startCuesPending === true &&
      passesCompleted === 0 &&
      originCues.some((cue) => (invocations.get(cue.functionId) ?? 0) > 0)
    )
      return false;
  }
  return cuePoints.every(({ point, functionId }) => {
    const reachedInPass =
      positionMs > point ||
      (positionMs === point && !(point === origin && startCuesPending === true));
    return (invocations.get(functionId) ?? 0) <= passesCompleted + (reachedInPass ? 1 : 0);
  });
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
