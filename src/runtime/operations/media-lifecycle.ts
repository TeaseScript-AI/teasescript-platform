import { type InstructionPlan, type PlanSourceLocation, mainSourceSpan } from "../../plan/model.js";
import { cloneCaptures, sweepRetainedScopes } from "../captures.js";
import { interruptFrame } from "../activations.js";
import type { SourceSpan } from "../../source.js";
import type {
  RuntimeActionSettlementSnapshot,
  RuntimeMediaActionSnapshot,
  RuntimeMediaPlaybackActionSnapshot,
  RuntimeMediaPlaybackSettlementSnapshot,
  RuntimeMediaSettlementSnapshot,
} from "../actions/model.js";
import type { ActionCompletedEvent, DeveloperWarningEvent, InterpreterEvent } from "../events.js";
import {
  commitMediaEvent,
  isActiveMedia,
  mediaCuePointMs,
  mediaEndMs,
  nextMediaEvent,
  stopMedia,
  type MediaTimelineEvent,
  type RuntimeMediaSnapshot,
} from "../media.js";
import type { RuntimeSnapshot } from "../state.js";
import { assertEventSequenceCapacity, copySpan, takeSequence } from "./support.js";

export type MediaWaitOutcome = RuntimeMediaPlaybackSettlementSnapshot["outcome"];

/** The active background action of a media handle, if the media is still running or paused. */
export function activeMediaAction(
  snapshot: RuntimeSnapshot,
  mediaId: number,
): RuntimeMediaActionSnapshot | undefined {
  return snapshot.backgroundActions.find(
    (action): action is RuntimeMediaActionSnapshot =>
      action.kind === "media" && action.media.mediaId === mediaId,
  );
}

export function mediaRecord(
  snapshot: RuntimeSnapshot,
  mediaId: number,
): RuntimeMediaSnapshot | undefined {
  return (
    activeMediaAction(snapshot, mediaId)?.media ??
    snapshot.settledMedia.find((media) => media.mediaId === mediaId)
  );
}

/** The video that occupies the Stage, if any. */
function activeStageVideo(snapshot: RuntimeSnapshot): RuntimeMediaActionSnapshot | undefined {
  return snapshot.backgroundActions.find(
    (action): action is RuntimeMediaActionSnapshot =>
      action.kind === "media" && action.media.media === "video" && isActiveMedia(action.media),
  );
}

export function mediaSpan(plan: InstructionPlan, owningInstruction: number): SourceSpan {
  return copySpan(plan.instructions[owningInstruction]?.span ?? mainSourceSpan(plan));
}

export function emitDeveloperWarning(
  snapshot: RuntimeSnapshot,
  events: InterpreterEvent[],
  code: string,
  message: string,
  span: SourceSpan | PlanSourceLocation,
): void {
  events.push(
    Object.freeze({
      kind: "developerWarning",
      sequence: takeSequence(snapshot),
      severity: "warning",
      code,
      message,
      span: copySpan(span),
    } satisfies DeveloperWarningEvent),
  );
}

/**
 * Commits one timeline event at the current scene time: the cue blocks it reaches are queued in source order, and a
 * natural finish queues the `finish` block and settles the media and any wait on it.
 */
export function applyMediaEvent(
  plan: InstructionPlan | null,
  snapshot: RuntimeSnapshot,
  action: RuntimeMediaActionSnapshot,
  event: MediaTimelineEvent,
  events: InterpreterEvent[],
  span: SourceSpan | PlanSourceLocation,
): void {
  const media = action.media;
  const outcome = commitMediaEvent(media, event);
  for (const functionId of outcome.cueFunctionIds) {
    queueMediaCue(snapshot, media, functionId);
  }
  if (outcome.finished) {
    if (media.finishFunctionId !== null) {
      queueMediaCue(snapshot, media, media.finishFunctionId);
    }
    settleMediaAction(plan, snapshot, action, events, span);
  }
}

/**
 * Commits this media's events due before the current scene time, or, with `includeNow`, also its arrivals due exactly
 * now. A script operation commits the earlier events before changing the media, so playback that already reached a
 * boundary is never lost; events due exactly now belong to catch-up order, where they may follow other work due now.
 * After a seek, `includeNow` completes a pass the seek reached, at once.
 */
export function drainMediaEvents(
  plan: InstructionPlan | null,
  snapshot: RuntimeSnapshot,
  action: RuntimeMediaActionSnapshot,
  events: InterpreterEvent[],
  span: SourceSpan | PlanSourceLocation,
  includeNow = false,
): void {
  const now = snapshot.currentSessionTimeMs;
  while (snapshot.backgroundActions.includes(action)) {
    const event = nextMediaEvent(action.media);
    if (
      event === null ||
      event.dueAtMs === null ||
      event.dueAtMs > now ||
      (event.dueAtMs === now && (!includeNow || event.kind === "departure"))
    )
      return;
    applyMediaEvent(plan, snapshot, action, event, events, span);
  }
}

/** Stops media and drops its queued, not yet started cue blocks. `finish` does not run. */
export function stopMediaAction(
  plan: InstructionPlan | null,
  snapshot: RuntimeSnapshot,
  action: RuntimeMediaActionSnapshot,
  events: InterpreterEvent[],
  span: SourceSpan | PlanSourceLocation,
): void {
  drainMediaEvents(plan, snapshot, action, events, span);
  if (!snapshot.backgroundActions.includes(action)) return;
  stopMedia(action.media, snapshot.currentSessionTimeMs);
  dropQueuedCues(snapshot, action.media.mediaId);
  settleMediaAction(plan, snapshot, action, events, span);
}

/** A new Stage image or video replaces an active Stage video, which stops. */
export function stopStageVideo(
  plan: InstructionPlan | null,
  snapshot: RuntimeSnapshot,
  events: InterpreterEvent[],
  span: SourceSpan | PlanSourceLocation,
): void {
  const video = activeStageVideo(snapshot);
  if (video !== undefined) stopMediaAction(plan, snapshot, video, events, span);
}

function dropQueuedCues(snapshot: RuntimeSnapshot, mediaId: number): void {
  for (let index = snapshot.pendingTimerHandlers.length - 1; index >= 0; index -= 1) {
    const invocation = snapshot.pendingTimerHandlers[index]!;
    if ("mediaId" in invocation && invocation.mediaId === mediaId) {
      snapshot.pendingTimerHandlers.splice(index, 1);
    }
  }
}

/**
 * Removes finished or stopped media from background work, retains its handle data, publishes its `actionCompleted`,
 * and releases a script waiting on it. Media settlements are not retained as `lastSettlement`.
 */
function settleMediaAction(
  plan: InstructionPlan | null,
  snapshot: RuntimeSnapshot,
  action: RuntimeMediaActionSnapshot,
  events: InterpreterEvent[],
  span: SourceSpan | PlanSourceLocation,
): void {
  const settlementKind = action.media.state;
  if (settlementKind !== "finished" && settlementKind !== "stopped") {
    throw new Error("Only finished or stopped media can settle.");
  }
  assertEventSequenceCapacity(snapshot, 1);
  const completionEventSequence = takeSequence(snapshot, 1);
  snapshot.backgroundActions.splice(snapshot.backgroundActions.indexOf(action), 1);
  snapshot.settledMedia.push(action.media);
  sweepRetainedScopes(snapshot, false);
  const settlement: RuntimeMediaSettlementSnapshot = Object.freeze({
    actionId: action.actionId,
    actionKind: "media",
    settlementKind,
    mediaId: action.media.mediaId,
    owningInstruction: action.owningInstruction,
    requestEventSequence: action.requestEventSequence,
    completionEventSequence,
    completedAtMs: snapshot.currentSessionTimeMs,
  });
  events.push(
    Object.freeze({
      kind: "actionCompleted",
      sequence: completionEventSequence,
      settlement,
      span: copySpan(span),
    } satisfies ActionCompletedEvent),
  );
  releaseMediaWait(
    plan,
    snapshot,
    action.media.mediaId,
    action.media.loaded ? settlementKind : "failed",
    events,
    span,
  );
}

/**
 * Settles a script wait on `mediaId`, in the foreground or suspended under an interrupt block. `loaded` releases only
 * a wait for the load result; an ending media releases any wait.
 */
export function releaseMediaWait(
  plan: InstructionPlan | null,
  snapshot: RuntimeSnapshot,
  mediaId: number,
  outcome: MediaWaitOutcome,
  events: InterpreterEvent[],
  span: SourceSpan | PlanSourceLocation,
): void {
  // An async play waits only for a usable load: anything else ends its wait as a failed load.
  const outcomeFor = (action: RuntimeMediaPlaybackActionSnapshot): MediaWaitOutcome =>
    action.until === "loaded" && outcome !== "loaded" ? "failed" : outcome;
  const releases = (action: RuntimeMediaPlaybackActionSnapshot | null | undefined): boolean =>
    action?.kind === "mediaPlayback" &&
    action.mediaId === mediaId &&
    (outcome !== "loaded" || action.until === "loaded");
  const foreground = snapshot.foregroundAction;
  if (foreground?.kind === "mediaPlayback" && releases(foreground)) {
    // A foreground wait settles only through Player reports and due work, which always supply the plan.
    if (plan === null) throw new Error("A foreground media wait settled without its plan.");
    const settlement = mediaWaitSettlement(snapshot, foreground, outcomeFor(foreground));
    snapshot.foregroundAction = null;
    snapshot.lastSettlement = settlement;
    snapshot.status = "running";
    snapshot.nextInstruction = foreground.continuationInstruction;
    pushWaitCompletion(events, span, settlement);
    return;
  }
  const frame = interruptFrame(snapshot);
  if (frame !== undefined) {
    const suspended = frame.timerInterruption?.suspendedAction;
    if (suspended?.kind !== "mediaPlayback" || !releases(suspended)) return;
    // Like a suspended delay: the continuation runs once the interrupt block returns normally, and the settlement is
    // not retained so released prepared output of the running block keeps its provenance.
    const settlement = mediaWaitSettlement(snapshot, suspended, outcomeFor(suspended));
    frame.returnInstruction = suspended.continuationInstruction;
    frame.timerInterruption = { ...frame.timerInterruption!, suspendedAction: null };
    pushWaitCompletion(events, span, settlement);
    return;
  }
}

function mediaWaitSettlement(
  snapshot: RuntimeSnapshot,
  action: RuntimeMediaPlaybackActionSnapshot,
  outcome: MediaWaitOutcome,
): RuntimeActionSettlementSnapshot {
  assertEventSequenceCapacity(snapshot, 1);
  return Object.freeze({
    actionId: action.actionId,
    actionKind: "mediaPlayback",
    settlementKind: "completed",
    outcome,
    mediaId: action.mediaId,
    owningInstruction: action.owningInstruction,
    continuationInstruction: action.continuationInstruction,
    requestEventSequence: action.requestEventSequence,
    completionEventSequence: takeSequence(snapshot, 1),
    completedAtMs: snapshot.currentSessionTimeMs,
  });
}

function pushWaitCompletion(
  events: InterpreterEvent[],
  span: SourceSpan | PlanSourceLocation,
  settlement: RuntimeActionSettlementSnapshot,
): void {
  events.push(
    Object.freeze({
      kind: "actionCompleted",
      sequence: settlement.completionEventSequence,
      settlement,
      span: copySpan(span),
    } satisfies ActionCompletedEvent),
  );
}

/** Queues a cue block in due order; consecutive invocations of the same block for the same media share one entry. */
function queueMediaCue(
  snapshot: RuntimeSnapshot,
  media: RuntimeMediaSnapshot,
  handlerFunctionId: number,
): void {
  const { mediaId } = media;
  const dueAtMs = snapshot.currentSessionTimeMs;
  const queue = snapshot.pendingTimerHandlers;
  let index = queue.length;
  while (index > 0 && queue[index - 1]!.dueAtMs > dueAtMs) index -= 1;
  const previous = queue[index - 1];
  if (
    previous !== undefined &&
    "mediaId" in previous &&
    previous.mediaId === mediaId &&
    previous.handlerFunctionId === handlerFunctionId &&
    previous.count < Number.MAX_SAFE_INTEGER
  ) {
    previous.count += 1;
    return;
  }
  queue.splice(index, 0, {
    mediaId,
    handlerFunctionId,
    rootScopeId: media.handlerRootScopeId!,
    captures: cloneCaptures(media.captures),
    dueAtMs,
    count: 1,
  });
}

/** Cue points outside the active range never fire; tell the developer once the range is known. */
export function warnUnreachableCues(
  snapshot: RuntimeSnapshot,
  action: RuntimeMediaActionSnapshot,
  span: SourceSpan,
  events: InterpreterEvent[],
): void {
  const media = action.media;
  const end = mediaEndMs(media);
  for (const cue of media.cues) {
    const point = mediaCuePointMs(media, cue);
    if (point < media.startAtMs || point > end) {
      emitDeveloperWarning(
        snapshot,
        events,
        "TSW012",
        `Media cue '${cue.kind} ${cue.offsetMs} ms' lies outside the playback range of "${media.source}" and never runs.`,
        span,
      );
    }
  }
}

/**
 * Script end and `exit` stop all media and drop queued cue blocks. Like timers, this is cleanup of the ended session
 * rather than individual settlements, so no events are emitted. The last Stage image stays.
 */
export function stopAllMediaForSessionEnd(snapshot: RuntimeSnapshot): void {
  for (let index = snapshot.backgroundActions.length - 1; index >= 0; index -= 1) {
    const action = snapshot.backgroundActions[index]!;
    if (action.kind !== "media") continue;
    stopMedia(action.media, snapshot.currentSessionTimeMs);
    snapshot.backgroundActions.splice(index, 1);
    snapshot.settledMedia.push(action.media);
  }
}
