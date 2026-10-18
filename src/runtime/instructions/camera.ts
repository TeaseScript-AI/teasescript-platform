import type { Instruction, PlanTag } from "../../plan/model.js";
import {
  addTag,
  conflictingTagMessage,
  notATagMessage,
  readTagText,
  type Tag,
} from "../../tags.js";
import type { Evaluator } from "../evaluator.js";
import { internalFault } from "../errors.js";
import {
  assertEventSequenceCapacity,
  requiredFutureActionCompletionEvents,
  setCapturedTemporary,
  takeSequence,
} from "../operations/support.js";
import { stateKey } from "../debug-trace.js";
import type { ActionRequestedEvent, InterpreterEvent } from "../events.js";
import type { SerializableRuntimeValue } from "../serializable-values.js";
import type { RuntimeSnapshot } from "../state.js";
import { ACTION_COMPLETION_EVENTS, type RuntimeCaptureActionSnapshot } from "../actions/model.js";
import { isList, isSet } from "../value-predicates.js";
import { describeValue } from "../../value-kinds.js";
import { advance, fault, type SourceSpan } from "./support.js";
import { copySpan } from "../../plan/source-location.js";

// The camera: its view on the Stage, and the photos takePhoto() asks for.

export function executeShowCamera(
  instruction: Extract<Instruction, { kind: "showCamera" }>,
  snapshot: RuntimeSnapshot,
  evaluator: Evaluator,
): void {
  // Shows the default camera's view, or moves it when it is shown already; the Player brings the camera, if any.
  snapshot.cameraView = { placement: instruction.placement, shown: true };
  // Showing the view sets all of it, its placement too.
  evaluator.trace?.writeState("assignment", stateKey("camera"), "whole", "camera", {
    kind: "cameraView",
  });
  if (instruction.destinationTemporary !== null) {
    setCapturedTemporary(snapshot.temporaries, instruction.destinationTemporary, {
      kind: "cameraView",
    });
    evaluator.trace?.writeTemporary(evaluator.callFrameId(), instruction.destinationTemporary, {
      kind: "cameraView",
    });
  }
  advance(snapshot);
}

export function executeHideCamera(snapshot: RuntimeSnapshot, evaluator: Evaluator): void {
  if (snapshot.cameraView !== null) snapshot.cameraView.shown = false;
  // Hiding it changes only whether it is shown.
  evaluator.trace?.writeState(
    "assignment",
    stateKey("camera"),
    { property: "shown" },
    "camera.shown",
    { kind: "cameraView" },
  );
  advance(snapshot);
}

export function executeCapture(
  instruction: Extract<Instruction, { kind: "capture" }>,
  snapshot: RuntimeSnapshot,
  evaluator: Evaluator,
  events: InterpreterEvent[],
): void {
  // The tags are checked before the capture is requested, so a pending capture only holds valid ones.
  const tags =
    instruction.tags === null
      ? null
      : captureTags(evaluator.evaluate(instruction.tags), instruction.tags.span);
  if (snapshot.temporaries.some((temporary) => temporary.id === instruction.destinationTemporary)) {
    throw fault(
      "TSR050",
      internalFault("The slot for the result of takePhoto() is already in use."),
      instruction.span,
    );
  }
  if (
    !Number.isSafeInteger(snapshot.nextActionId) ||
    snapshot.nextActionId >= Number.MAX_SAFE_INTEGER
  ) {
    throw fault(
      "TSR051",
      internalFault("The session has used up its action numbers."),
      instruction.span,
    );
  }
  // The request, a possible unavailable-camera warning, and the completion, besides what active actions reserve.
  assertEventSequenceCapacity(
    snapshot,
    1 + ACTION_COMPLETION_EVENTS.capture + requiredFutureActionCompletionEvents(snapshot),
    instruction.span,
  );
  const sequence = takeSequence(snapshot);
  const action: RuntimeCaptureActionSnapshot = Object.freeze({
    kind: "capture",
    capture: instruction.capture,
    tags,
    actionId: snapshot.nextActionId,
    owningInstruction: snapshot.nextInstruction,
    continuationInstruction: snapshot.nextInstruction + 1,
    ownerCallFrameId: snapshot.callFrames.at(-1)?.id ?? null,
    scopeDepth: snapshot.frames.length,
    loopDepth: snapshot.loopFrames.length,
    destinationTemporary: instruction.destinationTemporary,
    createdAtMs: snapshot.currentSessionTimeMs,
    requestEventSequence: sequence,
  });
  snapshot.nextActionId += 1;
  snapshot.foregroundAction = action;
  snapshot.status = "waiting";
  events.push(
    Object.freeze({
      kind: "actionRequested",
      sequence,
      action: { ...action },
      span: copySpan(instruction.span),
    } satisfies ActionRequestedEvent),
  );
}

/**
 * The tags of `takePhoto(tags: …)`: a list or set of texts such as `"bedroom"` or `"punishment: 4"`, read as tags in name
 * order. A repeated tag counts once, and its number wins; anything else fails before the capture is requested.
 */
function captureTags(value: SerializableRuntimeValue, span: SourceSpan): readonly PlanTag[] {
  if (!isList(value) && !isSet(value)) {
    throw fault(
      "TSR083",
      `takePhoto(tags:) takes a list of tags, but this is ${describeValue(value)}.`,
      span,
    );
  }
  const tags = new Map<string, Tag>();
  for (const item of value.items) {
    if (typeof item !== "string") {
      throw fault(
        "TSR083",
        `takePhoto(tags:) takes tags such as "bedroom" or "punishment: 4", but it holds ${describeValue(item)}.`,
        span,
      );
    }
    const tag = readTagText(item);
    if (tag === null) throw fault("TSR083", notATagMessage(item), span);
    if (addTag(tags, tag) === "conflict")
      throw fault("TSR083", conflictingTagMessage(tags.get(tag.name)!, tag), span);
  }
  return [...tags.values()]
    .sort((left, right) => (left.name < right.name ? -1 : 1))
    .map((tag) => Object.freeze({ name: tag.name, value: tag.value }));
}
