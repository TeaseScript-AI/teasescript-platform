import { argumentShapeProblem } from "../../argument-rules.js";
import { exactDurationMilliseconds } from "../values/temporal-operations.js";
import type { DelayDisplay, ExpressionPlan } from "../../plan/model.js";
import { parseMessageMarkup } from "../../message-markup.js";
import { internalFault } from "../errors.js";
import type { MessageRemovedEvent, MessageUpdatedEvent } from "../events.js";
import { takeSequence } from "../operations/support.js";
import {
  assignedTypeMessage,
  handleMemberMessage,
  handleMethod,
  handleProperty,
  isAssignableHandleProperty,
  isHandleMethod,
  isHandleProperty,
  type AssignableHandleProperty,
  type HandleKind,
  type HandleMethodName,
  type HandlePropertyName,
} from "../../handle-members.js";
import { unmeasurableLengthMessage } from "../../delay-rules.js";
import { formatDuration } from "../../duration.js";
import type {
  SerializableRuntimeCalendarDuration,
  SerializableRuntimeDuration,
  SerializableRuntimeValue,
  SerializableTimerHandle,
  SerializableMediaHandle,
  SerializableMessageHandle,
  SerializablePermanentButtonHandle,
} from "../values/serializable-values.js";
import { type RuntimeSnapshot, MAX_RUNTIME_SESSION_TIME_MS } from "../snapshot/state.js";
import { isAnyDuration } from "../values/value-predicates.js";
import { describeShownValue, shownChoice } from "../values/value-types.js";
import {
  pauseMedia,
  resumeMedia,
  seekMedia,
  setMediaVolume,
  type MediaHandleRecord,
  type MediaWarning,
} from "../background/media.js";
import {
  activeMediaAction,
  drainMediaEvents,
  mediaRecord,
  stopMediaAction,
} from "../operations/media-lifecycle.js";
import {
  pauseTimer,
  resumeTimer,
  setTimerDisplay,
  setTimerRemaining,
  setTimerRepeatDuration,
  type TimerHandleRecord,
  type TimerWarning,
} from "../background/timers.js";
import {
  activeTimerAction,
  expireTimerAction,
  stopTimerAction,
  timerRecord,
} from "../operations/timer-lifecycle.js";
import { removePermanentButtons } from "../background/permanent-buttons.js";
import { stateKey } from "../debug/debug-trace.js";
import { isValidSessionTime } from "../actions/delay.js";
import type { Evaluator } from "../evaluator.js";
import { type SourceSpan, fault, receiverLabel } from "./support.js";
import { copySpan } from "../../plan/source-location.js";

// Timer, media, message, camera-view, and permanent-button handles: their methods and their properties.

/** `button.remove()` removes a shown button and its queued click; removing it again does nothing (#836). */
export function callPermanentButton(
  evaluator: Evaluator,
  button: SerializablePermanentButtonHandle,
  name: string,
  positional: readonly SerializableRuntimeValue[],
  named: Readonly<Record<string, SerializableRuntimeValue>>,
  span: SourceSpan,
): null {
  handleMethodName("permanentButton", name, positional, named, span);
  removePermanentButtons(
    evaluator.snapshot,
    (shown) => shown.button.buttonId === button.buttonId,
    span,
    evaluator.events,
  );
  return null;
}

export function timerOf(
  evaluator: Evaluator,
  handle: SerializableTimerHandle,
  span: SourceSpan,
): TimerHandleRecord {
  const timer = timerRecord(evaluator.snapshot, handle.timerId);
  if (timer === undefined)
    throw fault(
      "TSR053",
      internalFault("A timer handle refers to a timer that the session does not have."),
      span,
    );
  return timer;
}

/** `pause()`, `resume()`, and `stop()`; repeated calls in the reached state are silent no-ops. */
export function callTimer(
  evaluator: Evaluator,
  handle: SerializableTimerHandle,
  name: string,
  positional: readonly SerializableRuntimeValue[],
  named: Readonly<Record<string, SerializableRuntimeValue>>,
  span: SourceSpan,
): null {
  const method = handleMethodName("timer", name, positional, named, span);
  const timer = timerOf(evaluator, handle, span);
  const action = activeTimerAction(evaluator.snapshot, handle.timerId);
  const now = evaluator.snapshot.currentSessionTimeMs;
  switch (method) {
    case "stop":
      if (action !== undefined) stopTimerAction(evaluator.snapshot, action, span, evaluator.events);
      return null;
    case "pause":
    case "resume": {
      if (method === "resume" && timer.state === "paused") {
        assertRepresentableRound(now, timer.remainingMs!, timer.repeat, span);
      }
      const warning = method === "pause" ? pauseTimer(timer, now) : resumeTimer(timer, now);
      if (warning !== null) evaluator.warn(warning.code, warning.message, span);
      // A round that is already due while its expiry work waits behind a block ends now, like `remaining = 0`.
      if (action !== undefined && timer.state === "paused" && timer.remainingMs === 0) {
        expireTimerAction(
          evaluator.snapshot,
          action,
          now,
          span,
          evaluator.events,
          evaluator.trace,
          evaluator.control,
        );
      }
      return null;
    }
    default: {
      const unhandled: never = method;
      throw new Error(`Timer method '${String(unhandled)}' has no implementation.`);
    }
  }
}

/** Assignment to `remaining`, `display`, or `repeatDuration` of a timer handle. */
export function assignTimerProperty(
  evaluator: Evaluator,
  handle: SerializableTimerHandle,
  name: string,
  value: SerializableRuntimeValue,
  span: SourceSpan,
): void {
  const timer = timerOf(evaluator, handle, span);
  const property = assignedHandleProperty("timer", name, value, span);
  const now = evaluator.snapshot.currentSessionTimeMs;
  let warning: TimerWarning | "expired" | null;
  switch (property) {
    case "display":
      // EVIDENCE: validation: assignedValueProblem accepted it through the display's domain (isTimerDisplay).
      warning = setTimerDisplay(timer, value as DelayDisplay);
      break;
    case "remaining":
    case "repeatDuration": {
      // EVIDENCE: validation: assignedValueProblem accepted it as a duration (isAnyDuration).
      const duration = value as SerializableRuntimeDuration | SerializableRuntimeCalendarDuration;
      exactDurationMilliseconds(duration, `Timer ${property}`, span);
      if (property === "remaining") {
        if (timer.state === "running" || timer.state === "paused") {
          assertRepresentableRound(now, Math.max(0, duration.milliseconds), timer.repeat, span);
        }
        warning = setTimerRemaining(timer, duration.milliseconds, now);
      } else {
        if (
          !(duration.milliseconds > 0) ||
          !isValidSessionTime(now + duration.milliseconds) ||
          now + duration.milliseconds <= now
        ) {
          throw fault(
            "TSR050",
            `Timer repeatDuration must be longer than zero and short enough for scene time to reach, but this is ${describeShownValue(value)}.`,
            span,
          );
        }
        warning = setTimerRepeatDuration(timer, duration.milliseconds, now);
      }
      break;
    }
    default: {
      const unhandled: never = property;
      throw new Error(`Timer property '${String(unhandled)}' has no implementation.`);
    }
  }
  if (warning === "expired") {
    expireTimerAction(
      evaluator.snapshot,
      activeTimerAction(evaluator.snapshot, handle.timerId)!,
      now,
      span,
      evaluator.events,
      evaluator.trace,
      evaluator.control,
    );
  } else if (warning !== null) {
    evaluator.warn(warning.code, warning.message, span);
  }
}

export function mediaOf(
  evaluator: Evaluator,
  handle: SerializableMediaHandle,
  span: SourceSpan,
): MediaHandleRecord {
  const media = mediaRecord(evaluator.snapshot, handle.mediaId);
  if (media === undefined)
    throw fault(
      "TSR053",
      internalFault("A media handle refers to media that the session does not have."),
      span,
    );
  return media;
}

/** `pause()`, `resume()`, and `stop()`; repeated calls in the reached state are silent no-ops. */
export function callMedia(
  evaluator: Evaluator,
  handle: SerializableMediaHandle,
  name: string,
  positional: readonly SerializableRuntimeValue[],
  named: Readonly<Record<string, SerializableRuntimeValue>>,
  span: SourceSpan,
): null {
  const method = handleMethodName("media", name, positional, named, span);
  const media = mediaOf(evaluator, handle, span);
  const action = activeMediaAction(evaluator.snapshot, handle.mediaId);
  switch (method) {
    case "stop":
      if (action !== undefined)
        stopMediaAction(null, evaluator.snapshot, action, evaluator.events, span);
      return null;
    case "pause":
    case "resume": {
      // Playback already reached by now is committed before its segment changes.
      if (action !== undefined)
        drainMediaEvents(null, evaluator.snapshot, action, evaluator.events, span);
      const now = evaluator.snapshot.currentSessionTimeMs;
      mediaWarning(
        evaluator,
        method === "pause" ? pauseMedia(media, now) : resumeMedia(media, now),
        span,
      );
      return null;
    }
    default: {
      const unhandled: never = method;
      throw new Error(`Media method '${String(unhandled)}' has no implementation.`);
    }
  }
}

/** Assignment to `position`, `remaining`, or `volume` of a media handle. */
export function assignMediaProperty(
  evaluator: Evaluator,
  handle: SerializableMediaHandle,
  name: string,
  value: SerializableRuntimeValue,
  span: SourceSpan,
): void {
  const media = mediaOf(evaluator, handle, span);
  const property = assignedHandleProperty("media", name, value, span);
  switch (property) {
    case "volume":
      // EVIDENCE: validation: assignedValueProblem accepted it through the volume's domain (isMediaVolume).
      mediaWarning(evaluator, setMediaVolume(media, value as number), span);
      return;
    case "position":
    case "remaining": {
      // EVIDENCE: validation: assignedValueProblem accepted it as a duration (isAnyDuration).
      const duration = value as SerializableRuntimeDuration | SerializableRuntimeCalendarDuration;
      if (!Number.isFinite(duration.milliseconds))
        throw fault(
          "TSR050",
          assignedTypeMessage("media", property, describeShownValue(value)),
          span,
        );
      exactDurationMilliseconds(duration, `Media ${property}`, span);
      const action = activeMediaAction(evaluator.snapshot, handle.mediaId);
      // Playback already reached by now is committed before the seek starts a new segment.
      if (action !== undefined)
        drainMediaEvents(null, evaluator.snapshot, action, evaluator.events, span);
      mediaWarning(
        evaluator,
        seekMedia(media, duration.milliseconds, evaluator.snapshot.currentSessionTimeMs, property),
        span,
      );
      // A seek to the end of the range completes the pass at once, like a timer's `remaining = 0`.
      if (action !== undefined) {
        drainMediaEvents(null, evaluator.snapshot, action, evaluator.events, span, true);
      }
      return;
    }
    default: {
      const unhandled: never = property;
      throw new Error(`Media property '${String(unhandled)}' has no implementation.`);
    }
  }
}

/** The default camera's view, which snapshot validation guarantees once a camera view handle exists. */
export function cameraView(evaluator: Evaluator): NonNullable<RuntimeSnapshot["cameraView"]> {
  const view = evaluator.snapshot.cameraView;
  if (view === null) throw new TypeError("A camera view handle outlived its camera view.");
  return view;
}

/** `view.placement = "window" | "stage"` moves a shown camera view; a hidden one stays hidden and only warns. */
export function assignCameraProperty(
  evaluator: Evaluator,
  name: string,
  value: SerializableRuntimeValue,
  span: SourceSpan,
): void {
  const property = assignedHandleProperty("camera", name, value, span);
  const view = cameraView(evaluator);
  if (!view.shown) {
    evaluator.warn(
      "TSW010",
      "This camera view is hidden, so its placement does not change. Show it with showCamera first.",
      span,
    );
    return;
  }
  switch (property) {
    case "placement":
      // EVIDENCE: validation: assignedValueProblem accepted it through the placement's domain (isCameraPlacement).
      view.placement = value as "window" | "stage";
      return;
    default: {
      const unhandled: never = property;
      throw new Error(`Camera view property '${String(unhandled)}' has no implementation.`);
    }
  }
}

/** The index of a message handle's live record; snapshot validation keeps one for every handle the state holds. */
export function liveMessage(
  evaluator: Evaluator,
  handle: SerializableMessageHandle,
  span: SourceSpan,
): number {
  const messages = evaluator.snapshot.liveMessages;
  let low = 0;
  let high = messages.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const id = messages[middle]!.messageId;
    if (id === handle.messageId) return middle;
    if (id < handle.messageId) low = middle + 1;
    else high = middle - 1;
  }
  throw fault(
    "TSR053",
    internalFault("A message handle refers to a message that the session does not have."),
    span,
  );
}

/**
 * `message.remove()` takes the message out of the conversation, which an event tells; its record keeps its text,
 * marked removed. Removing it again does nothing, and no pacing starts (#836).
 */
export function callMessage(
  evaluator: Evaluator,
  handle: SerializableMessageHandle,
  name: string,
  positional: readonly SerializableRuntimeValue[],
  named: Readonly<Record<string, SerializableRuntimeValue>>,
  span: SourceSpan,
): null {
  handleMethodName("messageHandle", name, positional, named, span);
  const index = liveMessage(evaluator, handle, span);
  const record = evaluator.snapshot.liveMessages[index]!;
  if (record.removed === true) return null;
  const sequence = takeSequence(evaluator.snapshot);
  evaluator.events.push(
    Object.freeze({
      kind: "messageRemoved",
      sequence,
      messageId: handle.messageId,
      span: copySpan(span),
    } satisfies MessageRemovedEvent),
  );
  evaluator.snapshot.liveMessages[index] = { ...record, removed: true };
  evaluator.trace?.messageRemoved(
    stateKey("message", handle.messageId),
    handle.messageId,
    record.sourceText,
    span,
    sequence,
  );
  return null;
}

/**
 * `message.text = …` gives the shown message new text in place, which an event tells; the same text again changes
 * nothing. Its speaker, presentation, and place in the conversation stay, and no pacing starts. A removed message
 * keeps the text it had, as a stopped timer keeps its state, and the write reports developer warning `TSW010`, whose
 * advice names `receiver` as written, or `line` for a receiver without a name.
 */
export function assignMessageProperty(
  evaluator: Evaluator,
  handle: SerializableMessageHandle,
  name: string,
  value: SerializableRuntimeValue,
  span: SourceSpan,
  receiver: ExpressionPlan,
): void {
  const property = assignedHandleProperty("messageHandle", name, value, span);
  if (property !== "text") {
    const unhandled: never = property;
    throw new Error(`Message property '${String(unhandled)}' has no implementation.`);
  }
  // EVIDENCE: validation: assignedValueProblem accepted it as text, the type the text property takes.
  const text = value as string;
  const index = liveMessage(evaluator, handle, span);
  const record = evaluator.snapshot.liveMessages[index]!;
  if (record.removed === true) {
    const label = receiverLabel(evaluator, receiver) ?? "line";
    evaluator.warn(
      "TSW010",
      `This message was removed, so its text does not change. Show a new message with say instead. To keep a message you want to change later, empty it with '${label}.text = ""' instead of removing it.`,
      span,
    );
    return;
  }
  if (record.sourceText === text) return;
  const content = parseMessageMarkup(text);
  const sequence = takeSequence(evaluator.snapshot);
  evaluator.events.push(
    Object.freeze({
      kind: "messageUpdated",
      sequence,
      messageId: handle.messageId,
      content,
      text: content.visibleText,
      span: copySpan(span),
    } satisfies MessageUpdatedEvent),
  );
  evaluator.snapshot.liveMessages[index] = { messageId: handle.messageId, sourceText: text };
  evaluator.trace?.messageText(
    stateKey("message", handle.messageId),
    handle.messageId,
    text,
    span,
    sequence,
  );
}

function mediaWarning(evaluator: Evaluator, warning: MediaWarning | null, span: SourceSpan): void {
  if (warning !== null) evaluator.warn(warning.code, warning.message, span);
}

/** `TSR003` for a property assignment on a value, which `plan` gives, that has no properties to assign. */
/** The property `name` of a handle of `kind` that a read finds (see `HANDLE_MEMBERS`), or `TSR017`. */
export function readHandleProperty<Kind extends HandleKind>(
  kind: Kind,
  name: string,
  span: SourceSpan,
): HandlePropertyName<Kind> {
  if (!isHandleProperty(kind, name))
    throw fault("TSR017", handleMemberMessage(kind, name, "read"), span);
  return name;
}

/**
 * The property `name` of a handle of `kind` that `value` may be assigned to (see `HANDLE_MEMBERS`): `TSR003` for one
 * that cannot be assigned, and `TSR050` for a value it does not take.
 */
function assignedHandleProperty<Kind extends HandleKind>(
  kind: Kind,
  name: string,
  value: SerializableRuntimeValue,
  span: SourceSpan,
): AssignableHandleProperty<Kind> {
  if (!isAssignableHandleProperty(kind, name))
    throw fault("TSR003", handleMemberMessage(kind, name, "assign"), span);
  const { type, domain } = handleProperty(kind, name)!.assign!;
  if (domain !== undefined) {
    if (!domain.accepts(value))
      throw fault(
        "TSR050",
        domain.message(domain.shows === "choice" ? shownChoice(value) : describeShownValue(value)),
        span,
      );
  } else if (type === "duration" ? !isAnyDuration(value) : typeof value !== "string")
    throw fault("TSR050", assignedTypeMessage(kind, name, describeShownValue(value)), span);
  return name;
}

/**
 * The method `name` of a handle of `kind` (see `HANDLE_MEMBERS`) for a call with these arguments: `TSR016` for a method
 * it does not have, and `TSR028` for arguments the method does not take.
 */
export function handleMethodName<Kind extends HandleKind>(
  kind: Kind,
  name: string,
  positional: readonly SerializableRuntimeValue[],
  named: Readonly<Record<string, SerializableRuntimeValue>>,
  span: SourceSpan,
): HandleMethodName<Kind> {
  if (!isHandleMethod(kind, name))
    throw fault("TSR016", handleMemberMessage(kind, name, "call"), span);
  const problem = argumentShapeProblem(
    name,
    handleMethod(kind, name)!.shape,
    positional.length,
    Object.keys(named),
  );
  if (problem !== undefined) throw fault("TSR028", problem.message, span);
  return name;
}

/** A running round must end at a supported session time strictly after a positive remaining time starts. */
function assertRepresentableRound(
  nowMs: number,
  remainingMs: number,
  repeat: boolean,
  span: SourceSpan,
): void {
  // A repeating timer whose remaining time becomes 0 s starts another positive round.
  if (remainingMs > 0 && nowMs === MAX_RUNTIME_SESSION_TIME_MS) {
    throw fault(
      "TSR050",
      `Scene time has reached its limit, so this timer cannot continue. ${repeat ? "Stop it." : "Stop it, or set its remaining time to 0 s."}`,
      span,
    );
  }
  const deadlineMs = nowMs + remainingMs;
  if (!isValidSessionTime(deadlineMs) || (remainingMs > 0 && deadlineMs <= nowMs)) {
    throw fault(
      "TSR050",
      isValidSessionTime(deadlineMs)
        ? unmeasurableLengthMessage("Timer remaining time", remainingMs, nowMs, "duration")
        : `Timer remaining time of ${formatDuration(remainingMs)} is too long for scene time to reach. Use a shorter duration.`,
      span,
    );
  }
}
