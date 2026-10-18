import { exactDurationMilliseconds } from "../temporal-operations.js";
import { resolveCaptures } from "../captures.js";
import type { Instruction, InstructionPlan } from "../../plan/model.js";
import {
  blockingRepeatMessage,
  FINISH_NEVER_RUNS_MESSAGE,
  fileReferenceRule,
  isMediaPosition,
  isMediaRange,
  isMediaRepeatCount,
  isMediaVolume,
  isRepeatBudget,
  MEDIA_REPEAT_COUNT_RULE,
  MEDIA_REPEAT_RULE,
  mediaPositionMessage,
  mediaRangeMessage,
  mediaVolumeMessage,
} from "../../handle-rules.js";
import type { Evaluator } from "../evaluator.js";
import { internalFault } from "../errors.js";
import {
  assertCounterCanAdvance,
  assertEventSequenceCapacity,
  requiredFutureActionCompletionEvents,
  setCapturedTemporary,
  takeSequence,
} from "../operations/support.js";
import { contextRootId } from "../activations.js";
import { stateKey } from "../debug-trace.js";
import type { ActionRequestedEvent, InterpreterEvent } from "../events.js";
import type { SerializableRuntimeValue } from "../serializable-values.js";
import type { RuntimeSnapshot } from "../state.js";
import type {
  RuntimeMediaActionSnapshot,
  RuntimeMediaPlaybackActionSnapshot,
} from "../actions/model.js";
import {
  emitDeveloperWarning,
  stopAllAudio,
  stopMediaAction,
  stopStageVideo,
} from "../operations/media-lifecycle.js";
import { cloneMedia, type RuntimeMediaRepeatSnapshot } from "../media.js";
import { describeShownValue } from "../value-types.js";
import { isAnyDuration } from "../value-predicates.js";
import { formatDuration } from "../../duration.js";
import { advance, durationFix, fault, type SourceSpan } from "./support.js";
import { copySpan } from "../../plan/source-location.js";

// Stage images, audio, and video.

/**
 * `showImage` sets the persistent Stage image and `hideImage` clears it; `null` clears it with a developer warning.
 * Either replaces an active Stage video, which stops.
 */
export function showImage(
  plan: InstructionPlan,
  instruction: Extract<Instruction, { kind: "showImage" }>,
  snapshot: RuntimeSnapshot,
  evaluator: Evaluator,
  events: InterpreterEvent[],
): void {
  const image = instruction.image === null ? null : evaluator.evaluate(instruction.image);
  if (image !== null && typeof image !== "string") {
    throw fault(
      "TSR050",
      `${fileReferenceRule("showImage")}, but this is ${describeShownValue(image)}.`,
      instruction.span,
    );
  }
  if (instruction.image !== null && image === null) {
    emitDeveloperWarning(
      snapshot,
      events,
      "TSW011",
      "showImage received null, so the Stage shows no image.",
      instruction.span,
    );
  }
  stopStageVideo(plan, snapshot, events, instruction.span);
  snapshot.stageImage = image;
  evaluator.trace?.image(image);
  advance(snapshot);
}

export function executeStopAudio(
  plan: InstructionPlan,
  instruction: Extract<Instruction, { kind: "stopAudio" }>,
  snapshot: RuntimeSnapshot,
  evaluator: Evaluator,
  events: InterpreterEvent[],
): void {
  for (const mediaId of stopAllAudio(plan, snapshot, events, instruction.span)) {
    // Like stop() on the handle of each sound.
    evaluator.trace?.writeState(
      "mutation",
      stateKey("media", mediaId),
      "timed",
      "media.stop()",
      null,
      instruction.span,
    );
  }
  advance(snapshot);
}

/** A media position or duration: a duration value, finite and not negative. */
function mediaMilliseconds(
  value: SerializableRuntimeValue,
  subject: string,
  span: SourceSpan,
): number {
  const milliseconds = isAnyDuration(value)
    ? exactDurationMilliseconds(value, subject, span)
    : Number.NaN;
  if (!isMediaPosition(milliseconds)) {
    throw fault(
      "TSR050",
      typeof value === "number"
        ? `A media position is a duration, but this is ${describeShownValue(value)}. ${durationFix(value, "30 s")}`
        : mediaPositionMessage(subject, describeShownValue(value)),
      span,
    );
  }
  return milliseconds;
}

function mediaRepeat(
  instruction: Extract<Instruction, { kind: "playMedia" }>,
  value: SerializableRuntimeValue,
): RuntimeMediaRepeatSnapshot {
  const repeat = instruction.repeat;
  if (repeat.kind === "once" || repeat.kind === "indefinite") return { kind: repeat.kind };
  if (repeat.kind === "times") {
    if (typeof value !== "number" || !isMediaRepeatCount(value)) {
      throw fault(
        "TSR050",
        `${MEDIA_REPEAT_COUNT_RULE}, but this is ${describeShownValue(value)}.`,
        repeat.count.span,
      );
    }
    return { kind: "count", passes: value };
  }
  if (value === true) return { kind: "indefinite" };
  if (value === false) return { kind: "once" };
  if (isAnyDuration(value)) {
    // A calendar duration has no fixed length (ADR 0026), whatever its parts.
    const milliseconds = exactDurationMilliseconds(value, "A repeat budget", repeat.value.span);
    if (isRepeatBudget(milliseconds)) return { kind: "budget", milliseconds };
  }
  throw fault(
    "TSR050",
    `${MEDIA_REPEAT_RULE}, but this is ${describeShownValue(value)}.`,
    repeat.value.span,
  );
}

/**
 * Starts audio or video. Operands are evaluated in plan order and validated before any state changes. The script then
 * waits: an async play until the Player reports the load result, a blocking play until the media ends. A new video
 * replaces an active Stage video. A `null` file plays nothing, with a developer warning.
 */
export function startMedia(
  plan: InstructionPlan,
  instruction: Extract<Instruction, { kind: "playMedia" }>,
  snapshot: RuntimeSnapshot,
  evaluator: Evaluator,
  events: InterpreterEvent[],
): void {
  const file = evaluator.evaluate(instruction.file);
  const repeatValue =
    instruction.repeat.kind === "value"
      ? evaluator.evaluate(instruction.repeat.value)
      : instruction.repeat.kind === "times"
        ? evaluator.evaluate(instruction.repeat.count)
        : null;
  const startAt = instruction.startAt === null ? null : evaluator.evaluate(instruction.startAt);
  const endAt = instruction.endAt === null ? null : evaluator.evaluate(instruction.endAt);
  const volume = instruction.volume === null ? null : evaluator.evaluate(instruction.volume);
  const offsets = instruction.cues.map((cue) => evaluator.evaluate(cue.offset));
  if (file !== null && typeof file !== "string") {
    throw fault(
      "TSR050",
      `${fileReferenceRule(instruction.media === "audio" ? "playAudio" : "playVideo")}, but this is ${describeShownValue(file)}.`,
      instruction.file.span,
    );
  }
  const repeat = mediaRepeat(instruction, repeatValue);
  if (!instruction.async && repeat.kind === "indefinite") {
    throw fault(
      "TSR050",
      blockingRepeatMessage(instruction.media === "audio" ? "playAudio" : "playVideo"),
      instruction.span,
    );
  }
  if (repeat.kind === "indefinite" && instruction.finishFunctionId !== null) {
    throw fault("TSR050", FINISH_NEVER_RUNS_MESSAGE, instruction.span);
  }
  // A supplied option is validated even when it evaluates to null; only an omitted option takes its default.
  const startAtMs =
    instruction.startAt === null
      ? 0
      : mediaMilliseconds(startAt, "startAt", instruction.startAt.span);
  const endAtMs =
    instruction.endAt === null ? null : mediaMilliseconds(endAt, "endAt", instruction.endAt.span);
  if (instruction.endAt !== null && endAtMs !== null && !isMediaRange(startAtMs, endAtMs)) {
    throw fault(
      "TSR050",
      mediaRangeMessage(
        describeShownValue(endAt),
        instruction.startAt === null ? formatDuration(0) : describeShownValue(startAt),
      ),
      instruction.endAt.span,
    );
  }
  if (instruction.volume !== null && !isMediaVolume(volume)) {
    throw fault("TSR050", mediaVolumeMessage(describeShownValue(volume)), instruction.volume.span);
  }
  const cues = instruction.cues.map((cue, index) => ({
    kind: cue.kind,
    offsetMs: mediaMilliseconds(offsets[index]!, `${cue.kind} position`, cue.offset.span),
    functionId: cue.functionId,
  }));
  if (
    !Number.isSafeInteger(snapshot.nextActionId) ||
    snapshot.nextActionId >= Number.MAX_SAFE_INTEGER - 1
  ) {
    throw fault(
      "TSR051",
      internalFault("The session has used up its action numbers."),
      instruction.span,
    );
  }
  assertCounterCanAdvance(snapshot.nextMediaId, "nextMediaId");
  // Two requests, their eventual completions, a possible warning, and the other active actions' completions.
  assertEventSequenceCapacity(
    snapshot,
    5 + requiredFutureActionCompletionEvents(snapshot),
    instruction.span,
  );
  const captures = resolveCaptures(snapshot, instruction.captures, instruction.span);
  if (instruction.media === "video") stopStageVideo(plan, snapshot, events, instruction.span);
  const mediaId = snapshot.nextMediaId;
  const mediaSequence = takeSequence(snapshot);
  const action: RuntimeMediaActionSnapshot = {
    kind: "media",
    actionId: snapshot.nextActionId,
    owningInstruction: snapshot.nextInstruction,
    createdAtMs: snapshot.currentSessionTimeMs,
    requestEventSequence: mediaSequence,
    media: {
      mediaId,
      handlerRootScopeId:
        instruction.cues.length > 0 || instruction.finishFunctionId !== null
          ? contextRootId(snapshot)
          : null,
      captures,
      media: instruction.media,
      source: file ?? "",
      state: "running",
      loaded: false,
      durationMs: null,
      startAtMs,
      endAtMs,
      volume: typeof volume === "number" ? volume : 1,
      repeat,
      cues,
      finishFunctionId: instruction.finishFunctionId,
      segment: 0,
      committedProgressMs: 0,
      positionMs: startAtMs,
      elapsedMs: 0,
      passesCompleted: 0,
      segmentPositionMs: startAtMs,
      segmentPasses: 0,
      segmentElapsedMs: 0,
      startCuesPending: false,
      points: [],
    },
  };
  snapshot.nextActionId += 1;
  snapshot.nextMediaId += 1;
  snapshot.backgroundActions.push(action);
  if (instruction.destinationTemporary !== null) {
    const handle = { kind: "mediaHandle" as const, mediaId };
    setCapturedTemporary(snapshot.temporaries, instruction.destinationTemporary, handle);
    evaluator.trace?.writeTemporary(
      evaluator.callFrameId(),
      instruction.destinationTemporary,
      handle,
    );
  }
  events.push(
    Object.freeze({
      kind: "actionRequested",
      sequence: mediaSequence,
      action: { ...action, media: cloneMedia(action.media) },
      span: copySpan(instruction.span),
    } satisfies ActionRequestedEvent),
  );
  if (file === null) {
    emitDeveloperWarning(
      snapshot,
      events,
      "TSW011",
      `${instruction.media === "audio" ? "playAudio" : "playVideo"} received null, so nothing plays.`,
      instruction.span,
    );
    stopMediaAction(plan, snapshot, action, events, instruction.span);
    advance(snapshot);
    return;
  }
  const waitSequence = takeSequence(snapshot);
  const wait: RuntimeMediaPlaybackActionSnapshot = Object.freeze({
    kind: "mediaPlayback",
    actionId: snapshot.nextActionId,
    owningInstruction: snapshot.nextInstruction,
    continuationInstruction: snapshot.nextInstruction + 1,
    ownerCallFrameId: snapshot.callFrames.at(-1)?.id ?? null,
    scopeDepth: snapshot.frames.length,
    loopDepth: snapshot.loopFrames.length,
    createdAtMs: snapshot.currentSessionTimeMs,
    mediaId,
    until: instruction.async ? "loaded" : "ended",
    requestEventSequence: waitSequence,
  });
  snapshot.nextActionId += 1;
  snapshot.foregroundAction = wait;
  snapshot.status = "waiting";
  events.push(
    Object.freeze({
      kind: "actionRequested",
      sequence: waitSequence,
      action: { ...wait },
      span: copySpan(instruction.span),
    } satisfies ActionRequestedEvent),
  );
}
